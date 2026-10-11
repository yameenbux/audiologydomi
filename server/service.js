"use strict";
const crypto = require("node:crypto");
// Booking service: every change to the diary goes through here, inside a transaction, with an audit entry,
// texts and live events that are released only once the transaction commits.
const { db, map } = require("./db");
const { TYPES, hm, first, dayPhrase, DAYS } = require("./domain");
const { rankCandidates, parseReply, planOffer, suggestSlots } = require("./refill");
const travel = require("./travel");
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
const dayAppts = (cid, day = 0) => all("SELECT * FROM appointments WHERE clinician_id = ? AND day = ? AND status != 'cancelled' ORDER BY start_min", cid, day).map(map.appt);
/** "today at 11:00", "tomorrow at 11:00", "on Wednesday 14 Oct at 11:00" */
const when = (day, start) => `${dayPhrase(day)} at ${hm(start)}`;
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
  return { clinician, ...rankCandidates({ slot, clinician, dayAppts: dayAppts(slot.clinicianId, slot.day).concat(slot), waitlist, patientsById, declined, sameDay: slot.day === 0 }) };
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
      ? `Thanks ${first(p.name)}, we've cancelled your visit ${when(a.day, a.start)}. We'll be in touch to rebook. ${BRAND}`
      : `Hi ${first(p.name)}, your visit ${when(a.day, a.start)} has been cancelled (${reason.toLowerCase()}). We'll be in touch to rebook. ${BRAND}` });
    sendSms({ to: "clinician", name: c.name, kind: "diary-change", toClinicianId: c.id, body: `${p.name} (${a.day === 0 ? "" : DAYS[a.day] + " "}${hm(a.start)}) has cancelled${byText ? " by text" : ""}. We're refilling the slot and will update you.` });
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
  const plan = planOffer({ leadMin: slot.day * 1440 + slot.start - now, drive: slot.drive, offerMinutes: settings().offerMinutes, eligible: eligible.length });
  const base = { slotId, clinicianId: slot.clinicianId, clinician: clinician.name, day: slot.day, start: slot.start, window, candidates: candidates.slice(0, 5), plan, now };

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
    const visit = `${when(slot.day, slot.start)} with ${clinician.first} (${TYPES[cand.type].name.toLowerCase()})`;
    const body = plan.mode === "parallel"
      ? `Hi ${first(p.name)}, it's ${BRAND}. A home visit has opened up ${visit}. The first person to reply YES gets it, replies close at ${deadline}. Reply NO to keep your place on the list.`
      : `Hi ${first(p.name)}, it's ${BRAND}. A home visit has opened up ${visit}. Would you like it? Reply YES by ${deadline} to accept, or NO to keep your place on the list.`;
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
  const clash = one("SELECT id FROM appointments WHERE clinician_id = ? AND day = ? AND start_min = ? AND status != 'cancelled'", slot.clinicianId, slot.day, slot.start);
  if (clash) throw new HttpError(409, "That slot has already been filled.");
  const id = newId("n");
  const note = `${old.name} cancelled. ${p.name} (${t.name.toLowerCase()}) now booked ${when(slot.day, slot.start)}, ${p.addr}.`;
  run("INSERT INTO appointments (id, clinician_id, patient_id, type, day, start_min, drive, status, moved, note, booked_min, filled_from) VALUES (?, ?, ?, ?, ?, ?, ?, 'booked', 1, ?, ?, ?)",
    id, slot.clinicianId, p.id, w.type, slot.day, slot.start, slot.drive, note, sandbox.nowMin(), slot.id);
  run("UPDATE appointments SET gap = 0 WHERE id = ?", slot.id);
  run("UPDATE waitlist SET status = 'booked' WHERE id = ?", waitlistId);
  run("UPDATE recalls SET status = 'booked' WHERE waitlist_id = ?", waitlistId);
  if (offerId) {
    run("UPDATE offers SET status = 'accepted', booked_appointment_id = ? WHERE id = ?", id, offerId);
    // Everyone else asked for this slot hears straight away that it has gone, and keeps their place.
    for (const o of pendingFor(slot.id)) {
      run("UPDATE offers SET status = 'superseded' WHERE id = ?", o.id);
      run("UPDATE waitlist SET status = 'waiting' WHERE id = ?", o.waitlist_id);
      const other = getPatient(map.wait(one("SELECT * FROM waitlist WHERE id = ?", o.waitlist_id)).patientId);
      sendSms({ to: other.phone, name: other.name, kind: "offer-taken", body: `Sorry ${first(other.name)}, the visit ${when(slot.day, slot.start)} has just been taken. You keep your place on our list. ${BRAND}` });
    }
  }
  addNote(p.id, `Moved forward from waiting list to ${DAYS[slot.day]} ${hm(slot.start)} with ${c.name}.`, { name: "Office" }, { silent: true });
  const patientBody = offerId
    ? `Thank you ${first(p.name)}, you're booked ${when(slot.day, slot.start)} with ${c.first}. We'll text when ${c.first} is on the way. ${BRAND}`
    : `Good news ${first(p.name)}: thanks to a cancellation, your home visit has moved forward to ${when(slot.day, slot.start).replace(/^today/, "TODAY")} with ${c.first}. Reply NO if you can't make it and we'll keep your place. ${BRAND}`;
  sendSms({ to: p.phone, name: p.name, kind: "confirmation", body: patientBody });
  sendSms({ to: "clinician", name: c.name, kind: "diary-change", toClinicianId: c.id, body: `Diary update: your ${slot.day === 0 ? "" : DAYS[slot.day] + " "}${hm(slot.start)} (${old.name}) cancelled. Now seeing ${p.name}, ${t.name.toLowerCase()}, ${p.addr} ${p.pc}. Record is in the app.` });
  audit(actor, "slot.filled", id, `${p.name} moved forward to ${hm(slot.start)} with ${c.name}`);
  const booking = { appointmentId: id, patient: p.name, clinician: c.name, day: slot.day, start: slot.start, instant: !offerId };
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
    // A CANCEL after a reminder means the visit we reminded them about; otherwise their next visit.
    const visit = !offer && one("SELECT * FROM appointments WHERE patient_id = ? AND status = 'booked' ORDER BY reminded DESC, day, start_min LIMIT 1", pr.id);
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

/**
 * Day-before reminders. Each one invites a CANCEL reply, which cancels that visit and starts refilling it,
 * so a patient who can't make it frees the slot a day ahead rather than at the door.
 */
function sendReminders(day, actor = "system") {
  return tx(() => {
    const due = all("SELECT a.*, p.name AS pname, p.phone, c.first AS cfirst FROM appointments a JOIN patients p ON p.id = a.patient_id JOIN clinicians c ON c.id = a.clinician_id WHERE a.day = ? AND a.status = 'booked' AND a.reminded = 0 ORDER BY a.start_min", day);
    for (const a of due) {
      sendSms({ to: a.phone, name: a.pname, kind: "reminder",
        body: `Hi ${first(a.pname)}, a reminder from ${BRAND}: ${a.cfirst} visits you ${when(day, a.start_min)} for your ${TYPES[a.type].name.toLowerCase()}. Can't make it? Reply CANCEL and we'll offer the time to someone waiting.` });
      run("UPDATE appointments SET reminded = 1 WHERE id = ?", a.id);
    }
    if (due.length) {
      audit(actor, "reminders.sent", `day:${day}`, `${due.length} reminder${due.length === 1 ? "" : "s"} for ${DAYS[day]}`);
      bus.emit({ type: "reminders.sent", day, count: due.length });
    }
    return { day, sent: due.length };
  });
}

/** Sends tomorrow's reminders once the demo clock passes the practice's reminder time. */
function sweepReminders() {
  const st = settings(), sb = sandbox.current();
  if (!st.reminders || sandbox.nowMin() < st.reminderAt || sb.remindedDay === 1) return;
  sb.remindedDay = 1;
  sendReminders(1);
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
      sendSms({ to: p.phone, name: p.name, kind: "offer-expired", body: `Hi ${first(p.name)}, replies for the visit ${when(slot.day, slot.start)} have now closed. You keep your place on our list. ${BRAND}` });
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
    if (a.day !== 0) throw new HttpError(409, `That visit is on ${DAYS[a.day]}, not today.`);
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
      run("INSERT INTO patients (id, name, age, addr, pc, phone) VALUES (?, ?, NULL, ?, ?, ?)", pid, name, String(input.addr || "Address to confirm"), travel.normalise(input.pc || "LS6"), String(input.phone || "07700 900000"));
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

/**
 * A clinician's round for one day, ready to draw: stops with coordinates, each leg's minutes and miles,
 * and the drive home. `insert` adds a proposed visit, to show where a new booking would fit.
 */
async function routeFor(cid, day, insert) {
  const c = getClinician(String(cid || ""));
  if (!c) throw new HttpError(404, "No such clinician.");
  if (!(day >= 0 && day < DAYS.length)) throw new HttpError(400, "Choose a day this week.");
  let stops = all("SELECT a.*, p.name, p.pc, p.addr FROM appointments a JOIN patients p ON p.id = a.patient_id WHERE a.clinician_id = ? AND a.day = ? AND a.status != 'cancelled' ORDER BY a.start_min", c.id, day)
    .map((r) => ({ id: r.id, name: r.name, pc: r.pc, addr: r.addr, type: r.type, start: r.start_min, end: r.start_min + TYPES[r.type].dur, status: r.status, moved: !!r.moved }));
  if (insert) {
    const pc = travel.normalise(insert.pc), type = TYPES[insert.type] ? insert.type : "review", start = Number(insert.start);
    await travel.prepare([pc, c.base, ...stops.map((s) => s.pc)]);
    if (!travel.known(pc)) throw new HttpError(400, "We can't place that postcode.");
    stops.push({ id: "proposed", name: String(insert.name || "New visit").slice(0, 80), pc, addr: "", type, start, end: start + TYPES[type].dur, status: "proposed", proposed: true });
    stops.sort((a, b) => a.start - b.start);
  }
  let prev = c.base;
  stops = stops.map((s) => {
    const d = travel.driveInfo(prev, s.pc);
    const leg = { min: d ? d.min : null, miles: travel.miles(prev, s.pc), source: d ? d.source : null };
    prev = s.pc;
    return { ...s, ...travel.locate(s.pc), leg };
  });
  const home = stops.length ? { min: travel.driveMinutes(prev, c.base) || 0, miles: travel.miles(prev, c.base) } : { min: 0, miles: 0 };
  const legs = stops.map((s) => s.leg).concat(home);
  const totals = { driveMin: legs.reduce((t, l) => t + (l.min || 0), 0), miles: Math.round(legs.reduce((t, l) => t + l.miles, 0) * 10) / 10, visits: stops.filter((s) => !s.proposed).length };
  const pts = [travel.locate(c.base), ...stops].filter(Boolean);
  const box = { n: Math.max(...pts.map((p) => p.lat)) + 0.01, s: Math.min(...pts.map((p) => p.lat)) - 0.01, e: Math.max(...pts.map((p) => p.lon)) + 0.015, w: Math.min(...pts.map((p) => p.lon)) - 0.015 };
  const districts = Object.entries(travel.CENTRES).filter(([, [lat, lon]]) => lat < box.n && lat > box.s && lon < box.e && lon > box.w).map(([name, [lat, lon]]) => ({ name, lat, lon }));
  return { clinician: { id: c.id, name: c.name, first: c.first, color: c.color }, day, base: { pc: c.base, ...travel.locate(c.base) }, stops, home, totals, districts };
}

/* ---------- Recalls ---------- */
const getRecall = (id) => { const r = one("SELECT * FROM recalls WHERE id = ?", String(id)); if (!r) throw new HttpError(404, "Recall not found."); return map.recall(r); };

/** Text a recall patient a link to book their own visit. They stay in the refill pool meanwhile. */
function textRecall(id, bookingUrl, user) {
  return tx(() => {
    const r = getRecall(id);
    if (!["due", "texted"].includes(r.status)) throw new HttpError(409, "That recall is already booked or removed.");
    const p = getPatient(r.patientId);
    sendSms({ to: p.phone, name: p.name, kind: "recall", body: `Hi ${first(p.name)}, it's ${BRAND}. Your ${r.reason.toLowerCase()} is due. Book a home visit at a time that suits you: ${bookingUrl} We'll also text you if a visit near you comes up sooner.` });
    run("UPDATE recalls SET status = 'texted', texted_at = ? WHERE id = ?", sandbox.stamp(), r.id);
    audit(user.name, "recall.texted", r.id, `${p.name}: ${r.reason}`);
    bus.emit({ type: "recall.updated", recallId: r.id });
    return getRecall(r.id);
  });
}

/** Take a recall off the list (and out of the refill pool), e.g. the patient has moved or declined. */
function dismissRecall(id, user) {
  return tx(() => {
    const r = getRecall(id);
    if (r.status === "booked") throw new HttpError(409, "That recall is already booked.");
    if (r.waitlistId) {
      if (one("SELECT 1 FROM waitlist WHERE id = ? AND status = 'offered'", r.waitlistId)) throw new HttpError(409, "They've just been offered a visit. Wait for their reply.");
      run("DELETE FROM waitlist WHERE id = ? AND status = 'waiting'", r.waitlistId);
    }
    run("UPDATE recalls SET status = 'dismissed' WHERE id = ?", r.id);
    audit(user.name, "recall.dismissed", r.id, getPatient(r.patientId).name);
    bus.emit({ type: "recall.updated", recallId: r.id });
    return { ok: true };
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

/* ---------- Booking a new visit ---------- */

/** Who the booking is for: an existing patient, or details typed in for a new one (not saved yet). */
function bookingPatient(input) {
  if (input.patientId && input.patientId !== "new") {
    const p = getPatient(input.patientId);
    if (!p) throw new HttpError(404, "Patient not found.");
    return p;
  }
  const name = String(input.name || "").trim();
  const pc = travel.normalise(input.pc);
  if (!name) throw new HttpError(400, "Enter the patient's name.");
  if (!travel.known(pc)) {
    throw new HttpError(400, travel.isFull(pc)
      ? `We couldn't find the postcode ${pc}. Check it, or enter just the district, like LS6.`
      : "Enter a Leeds postcode, like LS6 4DH (or just the district, like LS6), so we can work out travel.");
  }
  return { id: null, name, pc, addr: String(input.addr || "").trim() || "Address to confirm", phone: String(input.phone || "").trim() || "07700 900000", alerts: [] };
}

function slotsFor(patient, type, avail) {
  if (!TYPES[type]) throw new HttpError(400, "Choose a visit type.");
  const clinicians = all("SELECT * FROM clinicians ORDER BY id").map(map.clinician);
  const appts = all(`SELECT a.*, p.pc, p.name FROM appointments a JOIN patients p ON p.id = a.patient_id WHERE a.status != 'cancelled'`)
    .map((r) => ({ ...map.appt(r), pc: r.pc, name: r.name }));
  const wait = patient.id && one("SELECT prio FROM waitlist WHERE patient_id = ? AND status = 'waiting'", patient.id);
  return suggestSlots({ pc: patient.pc, type, avail: ["am", "pm"].includes(avail) ? avail : "any", clinicians, appts, now: sandbox.nowMin(), prio: wait ? wait.prio : "routine" });
}

/**
 * Fetch road times for this patient and every stop in the diary before ranking. Fast when they're cached,
 * and if the routing service is slow or down this gives up after a few seconds and estimates are used.
 */
async function warmRoutes(input) {
  const p = input.patientId && input.patientId !== "new" ? getPatient(String(input.patientId)) : null;
  const stops = all("SELECT DISTINCT p.pc FROM appointments a JOIN patients p ON p.id = a.patient_id WHERE a.status != 'cancelled'").map((r) => r.pc);
  const bases = all("SELECT base FROM clinicians").map((r) => r.base);
  await travel.prepare([p ? p.pc : travel.normalise(input.pc), ...stops, ...bases]);
}

/** Ranked options for the booking screen. */
async function findSlots(input) {
  await warmRoutes(input);
  const patient = bookingPatient(input);
  const slots = slotsFor(patient, input.type, input.avail).slice(0, 6);
  return { patient: { id: patient.id, name: patient.name, pc: patient.pc }, type: input.type, slots };
}

/** Book a visit into a slot. The slot is re-checked here, so two people can't book the same gap. */
async function bookVisit(input, user) {
  await warmRoutes(input);
  return tx(() => {
    const draft = bookingPatient(input);
    const c = getClinician(String(input.clinicianId || ""));
    if (!c) throw new HttpError(400, "Choose a clinician.");
    const start = Number(input.start), day = Number(input.day || 0);
    const slot = slotsFor(draft, input.type, input.avail).find((x) => x.clinicianId === c.id && x.day === day && x.start === start);
    if (!slot) throw new HttpError(409, "That slot has just gone. Search again for the latest options.");
    return placeVisit({ draft, c, type: input.type, day, start, slot, actor: user.name, by: "the office" });
  });
}

/** Write a new visit into a round (inside a transaction): patient if new, appointment, next leg, texts, audit, event. */
function placeVisit({ draft, c, type, day, start, slot, actor, by }) {
  let p = draft;
  if (!draft.id) {
    const id = newId("p");
    run("INSERT INTO patients (id, name, age, addr, pc, phone) VALUES (?, ?, NULL, ?, ?, ?)", id, draft.name, draft.addr, draft.pc, draft.phone);
    p = getPatient(id);
  }
  const t = TYPES[type];
  const id = newId("v");
  const note = `New visit booked by ${by}: ${p.name} (${t.name.toLowerCase()}) ${when(day, start)}, ${p.addr}.`;
  run("INSERT INTO appointments (id, clinician_id, patient_id, type, day, start_min, drive, status, note, booked_min) VALUES (?, ?, ?, ?, ?, ?, ?, 'booked', ?, ?)",
    id, c.id, p.id, type, day, start, slot.driveIn, note, sandbox.nowMin());
  // The visit after this one is now reached from the new patient's house.
  const after = one("SELECT id FROM appointments WHERE clinician_id = ? AND day = ? AND status != 'cancelled' AND start_min > ? ORDER BY start_min LIMIT 1", c.id, day, start);
  if (after) run("UPDATE appointments SET drive = ? WHERE id = ?", slot.driveOut, after.id);
  run("UPDATE waitlist SET status = 'booked' WHERE patient_id = ? AND status = 'waiting'", p.id);
  run("UPDATE recalls SET status = 'booked' WHERE patient_id = ? AND status IN ('due','texted')", p.id);
  addNote(p.id, `Booked by ${by} for ${DAYS[day]} at ${hm(start)} with ${c.name}.`, { name: actor }, { silent: true });
  sendSms({ to: p.phone, name: p.name, kind: "confirmation", body: `Hi ${first(p.name)}, your home visit with ${c.first} from ${BRAND} is booked ${when(day, start)} (${t.name.toLowerCase()}). We'll text when ${c.first} is on the way. Reply CANCEL if you can't make it.` });
  sendSms({ to: "clinician", name: c.name, kind: "diary-change", toClinicianId: c.id, body: `New visit${by === "the office" ? "" : " (booked online)"}: ${p.name}, ${t.name.toLowerCase()}, ${DAYS[day]} ${hm(start)} at ${p.addr} ${p.pc}. About ${slot.driveIn} min from your previous visit.` });
  audit(actor, "appointment.book", id, `${p.name} ${DAYS[day]} ${hm(start)} with ${c.name} (+${slot.extraDrive} min driving)`);
  bus.emit({ type: "appointment.booked", clinicianId: c.id, appointmentId: id, patient: p.name, day, start, extraDrive: slot.extraDrive, online: by !== "the office" });
  return { appointmentId: id, patientId: p.id, patient: p.name, clinician: c.name, clinicianId: c.id, day, start, label: slot.label, dayLabel: DAYS[day], extraDrive: slot.extraDrive };
}

/* ---------- Online booking by patients ---------- */
// Fittings need hearing aids ordered first, so the office books those.
const ONLINE_TYPES = ["assess", "review", "wax", "follow"];
// A self-booked visit may add at most this much driving, so online bookings can't scatter a round.
const ONLINE_MAX_EXTRA = 20;

/** What a patient may choose from: only from tomorrow, and only slots that fit a round efficiently. Never other patients' details. */
function publicSlotList(input) {
  const type = ONLINE_TYPES.includes(input.type) ? input.type : null;
  if (!type) throw new HttpError(400, "Choose what the visit is for.");
  const pc = travel.normalise(input.pc);
  if (!travel.known(pc)) throw new HttpError(400, "We couldn't find that postcode. Please check it, or call us and we'll book for you.");
  const avail = ["am", "pm"].includes(input.avail) ? input.avail : "any";
  const clinicians = Object.fromEntries(all("SELECT id, first FROM clinicians").map((r) => [r.id, r.first]));
  return slotsFor({ id: null, pc }, type, avail).filter((s) => s.day >= 1 && s.extraDrive <= ONLINE_MAX_EXTRA).slice(0, 4)
    .map((s) => ({ ref: `${s.clinicianId}.${s.day}.${s.start}`, clinicianId: s.clinicianId, day: s.day, start: s.start, dayLabel: DAYS[s.day], time: s.label, clinician: clinicians[s.clinicianId], slot: s }));
}

async function publicFindSlots(input) {
  await warmRoutes({ pc: input.pc });
  return { slots: publicSlotList(input).map(({ slot, ...rest }) => rest) };
}

async function publicBook(input) {
  const name = String(input.name || "").trim().replace(/\s+/g, " ");
  const phone = String(input.phone || "").replace(/[\s()-]/g, "");
  const addr = String(input.addr || "").trim();
  if (name.length < 2 || name.length > 80) throw new HttpError(400, "Please enter your full name.");
  if (!/^(\+44|0)7\d{9}$/.test(phone)) throw new HttpError(400, "Please enter a UK mobile number, so we can text you about the visit.");
  if (addr.length < 4 || addr.length > 120) throw new HttpError(400, "Please enter the first line of your address.");
  if (input.consent !== true) throw new HttpError(400, "Please agree to us texting you about this visit.");
  await warmRoutes({ pc: input.pc });
  return tx(() => {
    const choice = publicSlotList(input).find((x) => x.ref === String(input.ref || ""));
    if (!choice) throw new HttpError(409, "Sorry, that time has just been taken. Please choose another.");
    const digits = phone.replace(/^\+44/, "0");
    const known = all("SELECT * FROM patients").find((r) => r.phone.replace(/\D/g, "") === digits);
    const draft = known ? map.patient(known) : { id: null, name, pc: travel.normalise(input.pc), addr, phone: digits.replace(/^(\d{5})(\d{6})$/, "$1 $2"), alerts: [] };
    const r = placeVisit({ draft, c: getClinician(choice.clinicianId), type: input.type, day: choice.day, start: choice.start, slot: choice.slot, actor: "Online booking", by: "the patient online" });
    return { dayLabel: r.dayLabel, time: r.label, clinician: choice.clinician, when: when(r.day, r.start) };
  });
}
const onlineTypes = () => ONLINE_TYPES.map((k) => ({ key: k, name: TYPES[k].name, dur: TYPES[k].dur }));

module.exports = { textRecall, dismissRecall, publicFindSlots, publicBook, onlineTypes, routeFor, sendReminders, sweepReminders, findSlots, bookVisit, settings, HttpError, cancelAppointment, handleInbound, sweepExpired, setStatus, addNote, addToWaitlist, rank, metrics, getAppt, getPatient, getClinician, audit, tx };
