"use strict";
// Booking service: every change to the diary goes through here, inside a transaction, with an audit entry
// and an event for live screens.
const { db, map } = require("./db");
const { TYPES, hm, first } = require("./domain");
const { rankCandidates, parseReply } = require("./refill");
const { sendSms, recordInbound } = require("./notify");
const bus = require("./bus");

const settings = { mode: "offer", offerMinutes: Number(process.env.OFFER_MINUTES || 20) };
const BRAND = "Domi Hearing";

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

const one = (sql, ...a) => db.prepare(sql).get(...a);
const all = (sql, ...a) => db.prepare(sql).all(...a);
const run = (sql, ...a) => db.prepare(sql).run(...a);

const getAppt = (id) => { const r = one("SELECT * FROM appointments WHERE id = ?", id); return r && map.appt(r); };
const getPatient = (id) => { const r = one("SELECT * FROM patients WHERE id = ?", id); return r && map.patient(r); };
const getClinician = (id) => { const r = one("SELECT * FROM clinicians WHERE id = ?", id); return r && map.clinician(r); };
const dayAppts = (cid) => all("SELECT * FROM appointments WHERE clinician_id = ? AND status != 'cancelled' ORDER BY start_min", cid).map(map.appt);

function audit(actor, action, entity, detail) {
  run("INSERT INTO audit (actor, action, entity, detail) VALUES (?, ?, ?, ?)", actor, action, entity, detail);
}

function tx(fn) {
  db.exec("BEGIN IMMEDIATE");
  try { const r = fn(); db.exec("COMMIT"); return r; } catch (e) { db.exec("ROLLBACK"); throw e; }
}

function rank(slot, declined) {
  const clinician = getClinician(slot.clinicianId);
  const waitlist = all("SELECT * FROM waitlist WHERE status = 'waiting'").map(map.wait);
  const patientsById = Object.fromEntries(all("SELECT * FROM patients").map((r) => [r.id, map.patient(r)]));
  return { clinician, ...rankCandidates({ slot, clinician, dayAppts: dayAppts(slot.clinicianId).concat(slot), waitlist, patientsById, declined }) };
}

const declinedFor = (slotId) => all("SELECT waitlist_id FROM offers WHERE slot_id = ? AND status IN ('declined','expired')", slotId).map((r) => r.waitlist_id);

/** Cancel a visit and start refilling it. */
function cancelAppointment(id, reason, actor) {
  return tx(() => {
    const a = getAppt(id);
    if (!a) throw new HttpError(404, "That visit no longer exists.");
    if (!["booked", "enroute"].includes(a.status)) throw new HttpError(409, "Only visits that haven't started can be cancelled.");
    const p = getPatient(a.patientId);
    run("UPDATE appointments SET status = 'cancelled', reason = ? WHERE id = ?", reason, id);
    audit(actor, "appointment.cancel", id, `${p.name} at ${hm(a.start)}: ${reason}`);
    sendSms({ to: p.phone, name: p.name, kind: "cancellation", body: `Hi ${first(p.name)}, your visit today at ${hm(a.start)} has been cancelled (${reason.toLowerCase()}). We'll be in touch to rebook. ${BRAND}` });
    bus.emit({ type: "appointment.cancelled", clinicianId: a.clinicianId, slotId: id, patient: p.name, start: a.start, reason });
    return offerNext(id, actor);
  });
}

/** Offer the slot to the best remaining candidate, or book them outright in instant mode. Call inside tx. */
function offerNext(slotId, actor) {
  const slot = getAppt(slotId);
  const { clinician, window, candidates } = rank(slot, declinedFor(slotId));
  const top = candidates.find((c) => c.ok);
  const base = { slotId, clinicianId: slot.clinicianId, start: slot.start, window, candidates: candidates.slice(0, 5) };
  if (!top) {
    run("UPDATE appointments SET gap = 1 WHERE id = ?", slotId);
    audit(actor, "slot.unfilled", slotId, `No suitable patient for ${hm(slot.start)}`);
    bus.emit({ type: "slot.unfilled", ...base });
    return { outcome: "unfilled", ...base };
  }
  const p = getPatient(top.patientId);
  if (settings.mode === "instant") {
    const booking = book(slot, top.waitlistId, null, actor);
    return { outcome: "booked", top, booking, ...base };
  }
  const now = Date.now();
  const offer = one("INSERT INTO offers (slot_id, waitlist_id, status, score, sent_at, expires_at) VALUES (?, ?, 'pending', ?, ?, ?) RETURNING id",
    slotId, top.waitlistId, top.score, now, now + settings.offerMinutes * 60000);
  run("UPDATE waitlist SET status = 'offered' WHERE id = ?", top.waitlistId);
  const body = `Hi ${first(p.name)}, it's ${BRAND}. A home visit has opened up today at ${hm(slot.start)} with ${clinician.first} (${TYPES[top.type].name.toLowerCase()}). Would you like it? Reply YES to accept or NO to keep your place on the list.`;
  sendSms({ to: p.phone, name: p.name, kind: "offer", body });
  audit(actor, "offer.sent", `offer:${offer.id}`, `${p.name} offered ${hm(slot.start)} (score ${top.score})`);
  bus.emit({ type: "offer.sent", offerId: offer.id, patient: p.name, phone: p.phone, body, expiresInMin: settings.offerMinutes, top, ...base });
  return { outcome: "offered", offerId: offer.id, top, phone: p.phone, body, expiresInMin: settings.offerMinutes, ...base };
}

/** Put a waiting-list patient into a freed slot. Call inside tx. */
function book(slot, waitlistId, offerId, actor) {
  const w = map.wait(one("SELECT * FROM waitlist WHERE id = ?", waitlistId));
  const p = getPatient(w.patientId);
  const old = getPatient(slot.patientId);
  const c = getClinician(slot.clinicianId);
  const t = TYPES[w.type];
  const clash = one("SELECT id FROM appointments WHERE clinician_id = ? AND start_min = ? AND status != 'cancelled'", slot.clinicianId, slot.start);
  if (clash) throw new HttpError(409, "That slot has already been filled.");
  const id = "n" + Date.now().toString(36);
  const note = `${old.name} cancelled. ${p.name} (${t.name.toLowerCase()}) now booked at ${hm(slot.start)}, ${p.addr}.`;
  run("INSERT INTO appointments (id, clinician_id, patient_id, type, start_min, drive, status, moved, note) VALUES (?, ?, ?, ?, ?, ?, 'booked', 1, ?)",
    id, slot.clinicianId, p.id, w.type, slot.start, slot.drive, note);
  run("UPDATE waitlist SET status = 'booked' WHERE id = ?", waitlistId);
  if (offerId) {
    run("UPDATE offers SET status = 'accepted', booked_appointment_id = ? WHERE id = ?", id, offerId);
    run("UPDATE offers SET status = 'superseded' WHERE slot_id = ? AND status = 'pending' AND id != ?", slot.id, offerId);
  }
  run("INSERT INTO notes (patient_id, label, body, author) VALUES (?, 'Today', ?, 'Office')", p.id, `Moved forward from waiting list to ${hm(slot.start)} with ${c.name}.`);
  const patientBody = offerId
    ? `Thank you ${first(p.name)}, you're booked for today at ${hm(slot.start)} with ${c.first}. We'll text when ${c.first} is on the way. ${BRAND}`
    : `Good news ${first(p.name)}: thanks to a cancellation, your home visit has moved forward to TODAY at ${hm(slot.start)} with ${c.first}. Reply NO if you can't make it and we'll keep your place. ${BRAND}`;
  sendSms({ to: p.phone, name: p.name, kind: "confirmation", body: patientBody });
  sendSms({ to: "clinician", name: c.name, kind: "diary-change", toClinicianId: c.id, body: `Diary update: your ${hm(slot.start)} (${old.name}) cancelled. Now seeing ${p.name}, ${t.name.toLowerCase()}, ${p.addr} ${p.pc}. Record is in the app.` });
  audit(actor, "slot.filled", id, `${p.name} moved forward to ${hm(slot.start)} with ${c.name}`);
  const booking = { appointmentId: id, patient: p.name, clinician: c.name, start: slot.start, instant: !offerId };
  bus.emit({ type: "slot.filled", clinicianId: c.id, slotId: slot.id, ...booking });
  return booking;
}

/** Inbound text webhook (Twilio posts From and Body). */
function handleInbound(phone, body) {
  const digits = String(phone).replace(/\D/g, "").replace(/^44/, "0");
  const pr = all("SELECT * FROM patients").find((r) => r.phone.replace(/\D/g, "") === digits);
  const name = pr ? pr.name : phone;
  recordInbound({ phone, name, body });
  if (!pr) { audit("sms", "sms.unmatched", phone, body); return { matched: false }; }
  const offer = one(`SELECT o.* FROM offers o JOIN waitlist w ON w.id = o.waitlist_id WHERE w.patient_id = ? AND o.status = 'pending' ORDER BY o.id DESC LIMIT 1`, pr.id);
  bus.emit({ type: "sms.received", patient: pr.name, body, slotId: offer && offer.slot_id });
  if (!offer) { audit("sms", "sms.received", pr.id, body); return { matched: true, action: "logged" }; }
  const answer = parseReply(body);
  return tx(() => {
    const slot = getAppt(offer.slot_id);
    if (answer === "yes") {
      const booking = book(slot, offer.waitlist_id, offer.id, `patient:${pr.id}`);
      return { matched: true, action: "accepted", booking };
    }
    if (answer === "no") {
      run("UPDATE offers SET status = 'declined' WHERE id = ?", offer.id);
      run("UPDATE waitlist SET status = 'waiting' WHERE id = ?", offer.waitlist_id);
      audit(`patient:${pr.id}`, "offer.declined", `offer:${offer.id}`, `${pr.name} declined ${hm(slot.start)}`);
      bus.emit({ type: "offer.declined", slotId: slot.id, clinicianId: slot.clinicianId, patient: pr.name });
      return { matched: true, action: "declined", next: offerNext(slot.id, "system") };
    }
    sendSms({ to: pr.phone, name: pr.name, kind: "clarify", body: `Sorry ${first(pr.name)}, we didn't catch that. Please reply YES to take the visit or NO to keep your place. ${BRAND}` });
    return { matched: true, action: "clarified" };
  });
}

/** Offers nobody answered in time pass to the next person. Runs on a timer. */
function sweepExpired() {
  const due = all("SELECT * FROM offers WHERE status = 'pending' AND expires_at < ?", Date.now());
  for (const o of due) {
    tx(() => {
      const w = map.wait(one("SELECT * FROM waitlist WHERE id = ?", o.waitlist_id));
      const p = getPatient(w.patientId);
      const slot = getAppt(o.slot_id);
      run("UPDATE offers SET status = 'expired' WHERE id = ?", o.id);
      run("UPDATE waitlist SET status = 'waiting' WHERE id = ?", o.waitlist_id);
      sendSms({ to: p.phone, name: p.name, kind: "offer-expired", body: `Hi ${first(p.name)}, the visit at ${hm(slot.start)} has now gone to someone else. You keep your place on our list. ${BRAND}` });
      audit("system", "offer.expired", `offer:${o.id}`, `${p.name} did not reply in ${settings.offerMinutes} min`);
      bus.emit({ type: "offer.expired", slotId: slot.id, clinicianId: slot.clinicianId, patient: p.name });
      offerNext(slot.id, "system");
    });
  }
}

function setStatus(id, status, user) {
  return tx(() => {
    const a = getAppt(id);
    if (!a) throw new HttpError(404, "That visit no longer exists.");
    if (user.role === "clinician" && a.clinicianId !== user.clinicianId) throw new HttpError(403, "This visit is on another clinician's round.");
    const flow = { booked: ["enroute"], enroute: ["live"], live: ["done"] };
    if (!(flow[a.status] || []).includes(status)) throw new HttpError(409, `A visit that is ${a.status} can't move to ${status}.`);
    run("UPDATE appointments SET status = ?, seen = 1 WHERE id = ?", status, id);
    const p = getPatient(a.patientId);
    const c = getClinician(a.clinicianId);
    if (status === "enroute") {
      sendSms({ to: p.phone, name: p.name, kind: "on-the-way", fromClinicianId: c.id, body: `Hi ${first(p.name)}, ${c.first} from ${BRAND} is on the way and should be with you in about ${a.drive || 12} minutes.` });
    }
    audit(user.name, "appointment." + status, id, `${p.name} at ${hm(a.start)}`);
    bus.emit({ type: "appointment.updated", clinicianId: a.clinicianId, appointmentId: id, status });
    return getAppt(id);
  });
}

function addNote(patientId, body, user) {
  const p = getPatient(patientId);
  if (!p) throw new HttpError(404, "Patient not found.");
  const text = String(body || "").trim();
  if (!text) throw new HttpError(400, "Write a note first.");
  if (text.length > 4000) throw new HttpError(400, "Notes are limited to 4,000 characters.");
  const label = "Today " + new Date().toTimeString().slice(0, 5);
  const r = one("INSERT INTO notes (patient_id, label, body, author) VALUES (?, ?, ?, ?) RETURNING *", patientId, label, text, user.name);
  audit(user.name, "note.add", patientId, `${text.length} chars`);
  bus.emit({ type: "note.added", patientId });
  return map.note(r);
}

function addToWaitlist(input, user) {
  return tx(() => {
    let pid = input.patientId;
    if (!TYPES[input.type]) throw new HttpError(400, "Choose a visit type.");
    if (pid === "new") {
      const name = String(input.name || "").trim();
      if (!name) throw new HttpError(400, "Enter the patient's name.");
      pid = "p" + Date.now().toString(36);
      run("INSERT INTO patients (id, name, age, addr, pc, phone) VALUES (?, ?, NULL, ?, ?, ?)", pid, name, String(input.addr || "Address to confirm"), String(input.pc || "LS6").toUpperCase(), String(input.phone || "07700 900000"));
      run("INSERT INTO notes (patient_id, label, body, author) VALUES (?, 'Today', 'Added to waiting list.', ?)", pid, user.name);
    } else if (!getPatient(pid)) throw new HttpError(404, "Patient not found.");
    const id = "w" + Date.now().toString(36);
    run("INSERT INTO waitlist (id, patient_id, type, prio, days, avail, short_notice) VALUES (?, ?, ?, ?, 0, ?, ?)",
      id, pid, input.type, input.prio in { urgent: 1, soon: 1, routine: 1 } ? input.prio : "routine", input.avail in { any: 1, am: 1, pm: 1 } ? input.avail : "any", input.shortNotice ? 1 : 0);
    audit(user.name, "waitlist.add", id, getPatient(pid).name);
    bus.emit({ type: "waitlist.added", waitlistId: id });
    return { id, patientId: pid };
  });
}

module.exports = { settings, HttpError, cancelAppointment, handleInbound, sweepExpired, setStatus, addNote, addToWaitlist, rank, getAppt, getPatient, getClinician, audit };
