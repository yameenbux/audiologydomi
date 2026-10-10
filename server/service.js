"use strict";
const crypto = require("node:crypto");
// Booking service: every change to the diary goes through here, inside a transaction, with an audit entry,
// texts and live events that are released only once the transaction commits.
const { db, map } = require("./db");
const { TYPES, hm, first } = require("./domain");
const { rankCandidates, parseReply, planOffer } = require("./refill");
const { sendSms, recordInbound } = require("./notify");
const sandbox = require("./sandbox");
const bus = require("./bus");

const BRAND = "Domi Hearing";
const settings = () => sandbox.current().settings;

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

const one = (sql, ...a) => db.prepare(sql).get(...a);
const all = (sql, ...a) => db.prepare(sql).all(...a);
const run = (sql, ...a) => db.prepare(sql).run(...a);

const getAppt = (id) => { const r = one("SELECT * FROM appointments WHERE id = ?", id); return r && map.appt(r); };
const getPatient = (id) => { const r = one("SELECT * FROM patients WHERE id = ?", id); return r && map.patient(r); };
const getClinician = (id) => { const r = one("SELECT * FROM clinicians WHERE id = ?", id); return r && map.clinician(r); };
const dayAppts = (cid) => all("SELECT * FROM appointments WHERE clinician_id = ? AND status != 'cancelled' ORDER BY start_min", cid).map(map.appt);
const newId = (prefix) => prefix + crypto.randomUUID().replace(/-/g, "").slice(0, 10);

function audit(actor, action, entity, detail) {
  run("INSERT INTO audit (ts, actor, action, entity, detail) VALUES (?, ?, ?, ?, ?)", sandbox.stamp(), actor, action, entity, detail);
}

/** Transaction that nests safely; texts and events queued inside it go out after the outermost commit. */
function tx(fn) {
  const sb = sandbox.current();
  if (sb.txDepth > 0) { sb.txDepth++; try { return fn(); } finally { sb.txDepth--; } }
  sb.txDepth = 1;
  sb.pending = { sends: [], events: [] };
  db.exec("BEGIN IMMEDIATE");
  let result;
  try { result = fn(); db.exec("COMMIT"); }
  catch (e) { db.exec("ROLLBACK"); sb.pending = null; sb.txDepth = 0; throw e; }
  const { sends, events } = sb.pending;
  sb.pending = null; sb.txDepth = 0;
  events.forEach((f) => f());
  sends.forEach((f) => f());
  return result;
}

function rank(slot, declined) {
  const clinician = getClinician(slot.clinicianId);
  const waitlist = all("SELECT * FROM waitlist WHERE status = 'waiting'").map(map.wait);
  const patientsById = Object.fromEntries(all("SELECT * FROM patients").map((r) => [r.id, map.patient(r)]));
  return { clinician, ...rankCandidates({ slot, clinician, dayAppts: dayAppts(slot.clinicianId).concat(slot), waitlist, patientsById, declined }) };
}

const declinedFor = (slotId) => all("SELECT waitlist_id FROM offers WHERE slot_id = ? AND status IN ('declined','expired')", slotId).map((r) => r.waitlist_id);
const pendingFor = (slotId) => all("SELECT * FROM offers WHERE slot_id = ? AND status = 'pending'", slotId);

/** Cancel a visit and start refilling it. `byText` when the patient cancelled by SMS. */
function cancelAppointment(id, reason, actor, { byText = false } = {}) {
  return tx(() => {
    const a = getAppt(id);
    if (!a) throw new HttpError(404, "That visit no longer exists.");
    if (!["booked", "enroute"].includes(a.status)) throw new HttpError(409, "Only visits that haven't started can be cancelled.");
    const p = getPatient(a.patientId);
    const c = getClinician(a.clinicianId);
    run("UPDATE appointments SET status = 'cancelled', reason = ?, cancelled_min = ? WHERE id = ?", reason, sandbox.nowMin(), id);
    audit(actor, "appointment.cancel", id, `${p.name} at ${hm(a.start)}: ${reason}`);
    sendSms({ to: p.phone, name: p.name, kind: "cancellation", body: byText
      ? `Thanks ${first(p.name)}, we've cancelled today's ${hm(a.start)} visit. We'll be in touch to rebook. ${BRAND}`
      : `Hi ${first(p.name)}, your visit today at ${hm(a.start)} has been cancelled (${reason.toLowerCase()}). We'll be in touch to rebook. ${BRAND}` });
    sendSms({ to: "clinician", name: c.name, kind: "diary-change", toClinicianId: c.id, body: `${p.name} (${hm(a.start)}) has cancelled${byText ? " by text" : ""}. We're refilling the slot and will update you.` });
    const result = offerNext(id, actor, { first: true });
    const evt = { ...result, cancelled: { patient: p.name, reason, byText } };
    bus.emit({ type: "refill.started", ...evt });
    return evt;
  });
}

/**
 * Offer the slot to the best remaining candidates, or book outright in instant mode.
 * How many people are asked, and for how long, depends on how soon the visit starts (planOffer).
 */
function offerNext(slotId, actor, { first: isFirst = false } = {}) {
  const slot = getAppt(slotId);
  const { clinician, window, candidates } = rank(slot, declinedFor(slotId));
  const eligible = candidates.filter((c) => c.ok);
  const now = sandbox.nowMin();
  const plan = planOffer({ leadMin: slot.start - now, drive: slot.drive, offerMinutes: settings().offerMinutes, eligible: eligible.length });
  const base = { slotId, clinicianId: slot.clinicianId, clinician: clinician.name, start: slot.start, window, candidates: candidates.slice(0, 5), plan, now };

  if (plan.mode === "none" || plan.mode === "too-late") {
    const why = plan.mode === "none" ? "Nobody suitable on the waiting list" : `Too close to the visit to confirm anyone (${Math.max(0, plan.slack)} min of slack)`;
    run("UPDATE appointments SET gap = 1 WHERE id = ?", slotId);
    audit(actor, "slot.unfilled", slotId, `${hm(slot.start)}: ${why}`);
    if (!isFirst) bus.emit({ type: "slot.unfilled", ...base, why });
    return { outcome: "unfilled", why, ...base };
  }

  if (settings().mode === "instant") {
    const booking = book(slot, eligible[0].waitlistId, null, actor);
    return { outcome: "booked", top: eligible[0], booking, ...base };
  }

  const round = (one("SELECT MAX(round) AS r FROM offers WHERE slot_id = ?", slotId).r || 0) + 1;
  const deadline = hm(now + plan.windowMin);
  const chosen = eligible.slice(0, plan.count);
  const offers = chosen.map((cand) => {
    const p = getPatient(cand.patientId);
    const visit = `${hm(slot.start)} with ${clinician.first} (${TYPES[cand.type].name.toLowerCase()})`;
    const body = plan.mode === "parallel"
      ? `Hi ${first(p.name)}, it's ${BRAND}. A home visit has opened up today at ${visit}. The first person to reply YES gets it, replies close at ${deadline}. Reply NO to keep your place on the list.`
      : `Hi ${first(p.name)}, it's ${BRAND}. A home visit has opened up today at ${visit}. Would you like it? Reply YES by ${deadline} to accept, or NO to keep your place on the list.`;
    const o = one("INSERT INTO offers (slot_id, waitlist_id, status, score, round, sent_at, expires_at, deadline) VALUES (?, ?, 'pending', ?, ?, ?, ?, ?) RETURNING id",
      slotId, cand.waitlistId, cand.score, round, Date.now(), Date.now() + plan.windowMin * 60000, deadline);
    run("UPDATE waitlist SET status = 'offered' WHERE id = ?", cand.waitlistId);
    sendSms({ to: p.phone, name: p.name, kind: "offer", body });
    audit(actor, "offer.sent", `offer:${o.id}`, `${p.name} offered ${hm(slot.start)} (score ${cand.score}, round ${round})`);
    return { offerId: o.id, waitlistId: cand.waitlistId, patientId: p.id, name: p.name, phone: p.phone, body };
  });
  const result = { outcome: "offered", offers, round, deadline, ...base };
  if (!isFirst) bus.emit({ type: "offer.sent", ...result });
  return result;
}

/** Put a waiting-list patient into a freed slot. */
function book(slot, waitlistId, offerId, actor) {
  const w = map.wait(one("SELECT * FROM waitlist WHERE id = ?", waitlistId));
  const p = getPatient(w.patientId);
  const old = getPatient(slot.patientId);
  const c = getClinician(slot.clinicianId);
  const t = TYPES[w.type];
  const clash = one("SELECT id FROM appointments WHERE clinician_id = ? AND start_min = ? AND status != 'cancelled'", slot.clinicianId, slot.start);
  if (clash) throw new HttpError(409, "That slot has already been filled.");
  const id = newId("n");
  const note = `${old.name} cancelled. ${p.name} (${t.name.toLowerCase()}) now booked at ${hm(slot.start)}, ${p.addr}.`;
  run("INSERT INTO appointments (id, clinician_id, patient_id, type, start_min, drive, status, moved, note, booked_min, filled_from) VALUES (?, ?, ?, ?, ?, ?, 'booked', 1, ?, ?, ?)",
    id, slot.clinicianId, p.id, w.type, slot.start, slot.drive, note, sandbox.nowMin(), slot.id);
  run("UPDATE appointments SET gap = 0 WHERE id = ?", slot.id);
  run("UPDATE waitlist SET status = 'booked' WHERE id = ?", waitlistId);
  if (offerId) {
    run("UPDATE offers SET status = 'accepted', booked_appointment_id = ? WHERE id = ?", id, offerId);
    // Everyone else asked for this slot hears straight away that it has gone, and keeps their place.
    for (const o of pendingFor(slot.id)) {
      run("UPDATE offers SET status = 'superseded' WHERE id = ?", o.id);
      run("UPDATE waitlist SET status = 'waiting' WHERE id = ?", o.waitlist_id);
      const other = getPatient(map.wait(one("SELECT * FROM waitlist WHERE id = ?", o.waitlist_id)).patientId);
      sendSms({ to: other.phone, name: other.name, kind: "offer-taken", body: `Sorry ${first(other.name)}, the ${hm(slot.start)} visit has just been taken. You keep your place on our list. ${BRAND}` });
    }
  }
  addNote(p.id, `Moved forward from waiting list to ${hm(slot.start)} with ${c.name}.`, { name: "Office" }, { silent: true });
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

/**
 * A text from a patient. Sources: Twilio's signed webhook, or the office's demo simulator.
 * With a pending offer: YES books, NO declines. Without one: CANCEL (or NO) cancels today's visit.
 */
function handleInbound(phone, body) {
  const digits = String(phone).replace(/\D/g, "").replace(/^44/, "0");
  const pr = all("SELECT * FROM patients").find((r) => r.phone.replace(/\D/g, "") === digits);
  const name = pr ? pr.name : phone;
  return tx(() => {
    recordInbound({ phone, name, body });
    if (!pr) { audit("sms", "sms.unmatched", phone, body); return { matched: false }; }
    const answer = parseReply(body);
    const offer = one("SELECT o.* FROM offers o JOIN waitlist w ON w.id = o.waitlist_id WHERE w.patient_id = ? AND o.status = 'pending' ORDER BY o.id DESC LIMIT 1", pr.id);
    const visit = !offer && one("SELECT * FROM appointments WHERE patient_id = ? AND status = 'booked' ORDER BY start_min LIMIT 1", pr.id);
    bus.emit({ type: "sms.received", patient: pr.name, body, slotId: offer ? offer.slot_id : visit ? visit.id : null, clinicianId: null });
    const actor = `patient:${pr.id}`;

    if (offer) {
      const slot = getAppt(offer.slot_id);
      if (answer === "yes") return { matched: true, action: "accepted", booking: book(slot, offer.waitlist_id, offer.id, actor) };
      if (answer === "no" || answer === "cancel") {
        run("UPDATE offers SET status = 'declined' WHERE id = ?", offer.id);
        run("UPDATE waitlist SET status = 'waiting' WHERE id = ?", offer.waitlist_id);
        audit(actor, "offer.declined", `offer:${offer.id}`, `${pr.name} declined ${hm(slot.start)}`);
        const remaining = pendingFor(slot.id).length;
        bus.emit({ type: "offer.declined", slotId: slot.id, clinicianId: null, patient: pr.name, offerId: offer.id, remaining });
        return { matched: true, action: "declined", remaining, next: remaining ? null : offerNext(slot.id, "system") };
      }
      sendSms({ to: pr.phone, name: pr.name, kind: "clarify", body: `Sorry ${first(pr.name)}, we didn't catch that. Please reply YES to take the visit or NO to keep your place. ${BRAND}` });
      return { matched: true, action: "clarified" };
    }
    if (visit && (answer === "cancel" || answer === "no")) {
      return { matched: true, action: "cancelled", refill: cancelAppointment(visit.id, "Patient cancelled by text", actor, { byText: true }) };
    }
    audit(actor, "sms.received", pr.id, body);
    return { matched: true, action: "logged" };
  });
}

/** Offers nobody answered in time pass to the next people. Runs on a timer in every sandbox. */
function sweepExpired() {
  const due = all("SELECT * FROM offers WHERE status = 'pending' AND expires_at < ?", Date.now());
  const slots = new Set();
  tx(() => {
    for (const o of due) {
      const w = map.wait(one("SELECT * FROM waitlist WHERE id = ?", o.waitlist_id));
      const p = getPatient(w.patientId);
      const slot = getAppt(o.slot_id);
      run("UPDATE offers SET status = 'expired' WHERE id = ?", o.id);
      run("UPDATE waitlist SET status = 'waiting' WHERE id = ?", o.waitlist_id);
      sendSms({ to: p.phone, name: p.name, kind: "offer-expired", body: `Hi ${first(p.name)}, replies for the ${hm(slot.start)} visit have now closed. You keep your place on our list. ${BRAND}` });
      audit("system", "offer.expired", `offer:${o.id}`, `${p.name} did not reply by ${o.deadline}`);
      bus.emit({ type: "offer.expired", slotId: slot.id, clinicianId: null, patient: p.name, offerId: o.id });
      slots.add(slot.id);
    }
    for (const id of slots) if (!pendingFor(id).length) offerNext(id, "system");
  });
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

function addNote(patientId, body, user, { silent = false } = {}) {
  const p = getPatient(patientId);
  if (!p) throw new HttpError(404, "Patient not found.");
  const text = String(body || "").trim();
  if (!text) throw new HttpError(400, "Write a note first.");
  if (text.length > 4000) throw new HttpError(400, "Notes are limited to 4,000 characters.");
  const r = one("INSERT INTO notes (patient_id, label, body, author, created_at) VALUES (?, ?, ?, ?, ?) RETURNING *", patientId, "Today " + hm(sandbox.nowMin()), text, user.name, sandbox.stamp());
  if (!silent) { audit(user.name, "note.add", patientId, `${text.length} chars`); bus.emit({ type: "note.added", patientId, clinicianId: user.clinicianId || null }); }
  return map.note(r);
}

function addToWaitlist(input, user) {
  return tx(() => {
    let pid = input.patientId;
    if (!TYPES[input.type]) throw new HttpError(400, "Choose a visit type.");
    if (pid === "new") {
      const name = String(input.name || "").trim();
      if (!name) throw new HttpError(400, "Enter the patient's name.");
      pid = newId("p");
      run("INSERT INTO patients (id, name, age, addr, pc, phone) VALUES (?, ?, NULL, ?, ?, ?)", pid, name, String(input.addr || "Address to confirm"), String(input.pc || "LS6").toUpperCase(), String(input.phone || "07700 900000"));
      addNote(pid, "Added to waiting list.", user, { silent: true });
    } else if (!getPatient(pid)) throw new HttpError(404, "Patient not found.");
    const id = newId("w");
    const seq = one("SELECT COALESCE(MAX(added_seq), 0) + 1 AS s FROM waitlist").s;
    run("INSERT INTO waitlist (id, patient_id, type, prio, days, avail, short_notice, added_seq) VALUES (?, ?, ?, ?, 0, ?, ?, ?)",
      id, pid, input.type, input.prio in { urgent: 1, soon: 1, routine: 1 } ? input.prio : "routine", input.avail in { any: 1, am: 1, pm: 1 } ? input.avail : "any", input.shortNotice ? 1 : 0, seq);
    audit(user.name, "waitlist.add", id, getPatient(pid).name);
    bus.emit({ type: "waitlist.added", waitlistId: id });
    return { id, patientId: pid };
  });
}

/** What the office's income panel shows. Fee is the office's own figure, set in settings. */
function metrics() {
  const fee = settings().fee;
  const cancelled = all("SELECT * FROM appointments WHERE status = 'cancelled'").map(map.appt);
  const filled = all("SELECT * FROM appointments WHERE moved = 1").map(map.appt);
  const byId = Object.fromEntries(cancelled.map((a) => [a.id, a]));
  const times = filled.map((f) => byId[f.filledFrom] ? f.bookedMin - byId[f.filledFrom].cancelledMin : null).filter((x) => x != null);
  const open = cancelled.filter((a) => !filled.some((f) => f.filledFrom === a.id));
  return {
    fee, cancellations: cancelled.length, refilled: filled.length, open: open.length,
    recovered: filled.length * fee, atRisk: open.length * fee,
    fillRate: cancelled.length ? Math.round((filled.length / cancelled.length) * 100) : null,
    avgRefillMin: times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : null,
  };
}

module.exports = { settings, HttpError, cancelAppointment, handleInbound, sweepExpired, setStatus, addNote, addToWaitlist, rank, metrics, getAppt, getPatient, getClinician, audit, tx };
