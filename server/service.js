"use strict";
const crypto = require("node:crypto");
// Booking service: every change to the diary goes through here, inside a transaction, with an audit entry,
// texts and live events that are released only once the transaction commits.
const { db, map } = require("./db");
const { SOURCES, COUNTS, TYPES, DEFAULT_DUR, PVN_NOTICE_MIN, REASONS, hm, first, district, twAllows, twLabel, twParse } = require("./domain");
const cal = require("./calendar");
const { rankCandidates, parseReply, planOffer, suggestSlots, hoursOn } = require("./refill");
const travel = require("./travel");
const { sendSms, recordInbound } = require("./notify");
const sandbox = require("./sandbox");
const importer = require("./importer");
const auth = require("./auth");
const planner = require("./planner");
const regions = require("./regions");
const bus = require("./bus");
const pvn = require("./pvn");

const settings = () => sandbox.current().settings;
/** The practice's name, as patients see it: texts are signed by the practice, not by Domi. */
const practice = () => settings().practice;

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

const one = (sql, ...a) => db.prepare(sql).get(...a);
const all = (sql, ...a) => db.prepare(sql).all(...a);
const run = (sql, ...a) => db.prepare(sql).run(...a);

const getAppt = (id) => { const r = one("SELECT * FROM appointments WHERE id = ?", id); return r && map.appt(r); };
const getPatient = (id) => { const r = one("SELECT * FROM patients WHERE id = ?", id); return r && map.patient(r); };
const getClinician = (id) => { const r = one("SELECT * FROM clinicians WHERE id = ?", id); return r && map.clinician(r); };
const dayAppts = (cid, day = 0) => all("SELECT * FROM appointments WHERE clinician_id = ? AND day = ? AND status != 'cancelled' ORDER BY start_min", cid, day).map(map.appt);
/** "today at 11:00", "tomorrow at 11:00", "on Wednesday 14 Oct at 11:00" */
/** A visit type inside a sentence: "your private eye examination", but "your NHS sight test". */
const lowerName = (n) => (/^[A-Z]{2}/.test(n) ? n : n.charAt(0).toLowerCase() + n.slice(1));
const when = (day, start) => `${cal.phrase(day)} at ${hm(start)}`;
/** A day the office may book into: open, from today up to the booking limit (Settings, default 12 months). */
function bookableDay(day) {
  const max = cal.ahead("bookAheadDays");
  if (!(Number.isInteger(day) && day >= 0 && day <= max)) throw new HttpError(400, `Choose a day from today up to ${Math.round(max / 30.4)} months ahead.`);
  const why = cal.closedWhy(day);
  if (why) throw new HttpError(400, `The practice is closed on ${cal.label(day)} (${why}).`);
  return day;
}
/**
 * The earliest an NHS sight test can be claimed for this patient: their recall date (last test plus the months the
 * optometrist set, 12 unless changed) less one month, plus a day. Seen 15 Oct 2025 on a 12-month recall: not
 * before 16 Sep 2026. Earlier needs an early-retest reason on the GOS form, so the office must say so. Null when
 * there's no last test on record.
 */
function nhsFrom(p) {
  const ymd = (iso) => String(iso).slice(0, 10).split("-").map(Number);
  const addMonths = ([y, m, d], n) => { const first = new Date(Date.UTC(y, m - 1 + n, 1)), last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate(); return Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(d, last)); };
  const isDate = (v) => v && /^\d{4}-\d{2}-\d{2}/.test(v);
  let due, months = p && (p.recallMonths || 12);
  if (p && isDate(p.nextExam)) due = ymd(p.nextExam); // Opticabase's own next exam date, when imported
  else if (p && isDate(p.lastTest)) { const t = addMonths(ymd(p.lastTest), months); due = ymd(new Date(t).toISOString()); }
  else return null;
  const iso = new Date(addMonths(due, -1) + 864e5).toISOString().slice(0, 10);
  return { iso, day: cal.dayOf(iso), months, fromNextExam: !!(p && isDate(p.nextExam)), label: new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) };
}
/** Where a booking for this patient came from, unless the office said: on the recall list, a Facebook lead, a
 *  referral, seen before (an old recall), or new. */
function sourceFor(patientId, given) {
  if (given && SOURCES[given]) return given;
  if (!patientId) return "new";
  if (one("SELECT 1 FROM waitlist WHERE patient_id = ? AND source = 'recall'", patientId) || one("SELECT 1 FROM recalls WHERE patient_id = ? AND status IN ('due','texted','booked')", patientId)) return "recall";
  if (one("SELECT 1 FROM leads WHERE patient_id = ?", patientId)) return "facebook";
  if (one("SELECT 1 FROM referrals WHERE patient_id = ?", patientId)) return "referral";
  if (one("SELECT 1 FROM appointments WHERE patient_id = ? AND status = 'done'", patientId) || one("SELECT 1 FROM patients WHERE id = ? AND last_test IS NOT NULL", patientId)) return "old-recall";
  return "new";
}
/** The office changes where a booking came from, or how likely it is to go ahead (its true count). */
function setLikelihood(id, input, user) {
  return tx(() => {
    const a = one("SELECT * FROM appointments WHERE id = ?", String(id));
    if (!a) throw new HttpError(404, "That visit no longer exists.");
    const has = (k) => Object.prototype.hasOwnProperty.call(input, k), p = getPatient(a.patient_id), parts = [];
    if (has("source")) { if (!SOURCES[input.source]) throw new HttpError(400, "Choose where the booking came from."); run("UPDATE appointments SET source = ? WHERE id = ?", input.source, a.id); parts.push(`came from ${SOURCES[input.source].label.toLowerCase()}`); }
    if (has("reliability")) {
      const v = input.reliability == null ? null : Number(input.reliability);
      if (v != null && !COUNTS.includes(v)) throw new HttpError(400, "Choose a count of 1, 0.75, 0.5, 0.25 or 0.");
      run("UPDATE appointments SET reliability = ? WHERE id = ?", v, a.id); parts.push(v == null ? "count back to its source's" : `count ${v}`);
    }
    audit(user.name, "appointment.likelihood", a.id, `${p.name} ${cal.label(a.day)} ${hm(a.start_min)}: ${parts.join(", ")}`);
    bus.emit({ type: "appointment.updated", appointmentId: a.id });
    return getAppt(a.id);
  });
}
/** NHS numbers are 10 digits; the last is a modulus 11 check digit. */
function validNhsNumber(v) {
  if (!/^\d{10}$/.test(v)) return false;
  const c = 11 - (v.slice(0, 9).split("").reduce((t, d, i) => t + Number(d) * (10 - i), 0) % 11);
  return c !== 10 && (c === 11 ? 0 : c) === Number(v[9]);
}
/** The office lodged a visit's PVN in PCSE Online: record PCSE's reference against each patient on it. */
function lodgePvn(input, user) {
  return tx(() => {
    const ids = Array.isArray(input.apptIds) ? input.apptIds.map(String) : [];
    const ref = clean(input.ref, 24).replace(/\s+/g, "");
    if (!ids.length) throw new HttpError(400, "Choose the visit.");
    if (!/^[A-Za-z0-9-]{3,24}$/.test(ref)) throw new HttpError(400, "Enter the PVN reference PCSE Online gave you.");
    for (const id of ids) {
      const a = getAppt(id);
      if (!a || !TYPES[a.type].pvn) throw new HttpError(404, "That visit isn't an NHS sight test any more.");
      const t = one("SELECT * FROM pcse WHERE appointment_id = ? AND action = 'lodge' ORDER BY id DESC LIMIT 1", id);
      if (t) run("UPDATE pcse SET status = 'done', done_by = ?, ref = ? WHERE id = ?", user.name, ref, t.id);
      else run("INSERT INTO pcse (action, patient_id, appointment_id, day, start_min, status, created_at, done_by, ref) VALUES ('lodge', ?, ?, ?, ?, 'done', ?, ?, ?)", a.patientId, id, a.day, a.start, sandbox.stamp(), user.name, ref);
      audit(user.name, "pcse.lodged", id, `PVN ${ref} lodged for ${getPatient(a.patientId).name}, ${cal.label(a.day)} ${hm(a.start)}`);
    }
    bus.emit({ type: "pcse.updated" });
    return { ok: true, ref };
  });
}
/** A visit's early retest code, or the ICB's short-notice approval, for its PVN. */
function setPvnDetails(id, input, user) {
  return tx(() => {
    const a = one("SELECT * FROM appointments WHERE id = ?", String(id));
    if (!a || !TYPES[a.type].pvn) throw new HttpError(404, "That isn't an NHS sight test.");
    const has = (k) => Object.prototype.hasOwnProperty.call(input, k), parts = [];
    if (has("ert")) { const v = input.ert ? String(input.ert) : null; if (v && !pvn.ERT[v]) throw new HttpError(400, "Choose one of PCSE's early retest codes."); run("UPDATE appointments SET ert = ? WHERE id = ?", v, a.id); parts.push(v ? `early retest code ${v}` : "no early retest code"); }
    if (has("icb")) { run("UPDATE appointments SET pvn_icb = ? WHERE id = ?", icbOf(input), a.id); parts.push(icbOf(input) ? `ICB approval: ${icbOf(input)}` : "ICB approval removed"); }
    audit(user.name, "pcse.details", a.id, parts.join(", "));
    bus.emit({ type: "pcse.updated" });
    return { ok: true };
  });
}
/** Who at the ICB approved a short-notice NHS visit, as the office typed it (PCSE's form asks for the name). */
const icbOf = (input) => { const v = clean(input && input.icb, 80); return v.length >= 3 ? v : null; };
/** Refuse an NHS sight test PCSE can't be told about in time (48 working hours, or 3 weeks for a third patient at one
 *  address), unless the office records the ICB's approval for a short-notice visit. */
function checkPvn(patient, type, day, start, icb, exclude = null) {
  const problem = pvn.check({ patient, type, day, start, exclude });
  if (problem && !icb) throw new HttpError(409, problem.message);
  return problem;
}
/** Refuse an NHS sight test before the patient's recall line, unless the office gives an early-retest reason. */
function checkNhsLine(p, type, day, early) {
  if (!TYPES[type] || !TYPES[type].pvn) return;
  const f = nhsFrom(p);
  if (!f || day >= f.day || early) return;
  throw new HttpError(409, `${p.name} can't have an NHS sight test before ${f.label}: ${f.fromNextExam ? "a month before the next exam Opticabase set" : `their last was ${new Date(p.lastTest).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })}, on a ${f.months}-month recall`}. Book from then, or tick "early retest" if their sight has changed (the GOS form needs the reason).`);
}
/** The day-before reminder. Also shown on the Settings page, so the office sees exactly what patients get. */
const reminderText = (name, clinFirst, day, start, type, link) =>
  `Hi ${first(name)}, a reminder from ${practice()}: ${clinFirst} visits you ${when(day, start)} for your ${lowerName(TYPES[type].name)}. Can't make it? Reply CANCEL${link ? ` or go to ${link}` : ""}.`;
/** The text offering a cancelled visit to someone waiting. When the visit is close, the first YES wins. */
const offerText = (name, visit, deadline, firstWins) => firstWins
  ? `Hi ${first(name)}, it's ${practice()}. A home visit has opened up ${visit}. The first person to reply YES gets it, replies close at ${deadline}. Reply NO to keep your place on the list.`
  : `Hi ${first(name)}, it's ${practice()}. A home visit has opened up ${visit}. Would you like it? Reply YES by ${deadline} to accept, or NO to keep your place on the list.`;
const newId = (prefix) => prefix + crypto.randomUUID().replace(/-/g, "").slice(0, 10);
/**
 * Text a patient, unless they asked to be phoned instead (a landline, poor sight, can't read texts): then the
 * office calls them, so nothing is sent. Returns whether a text went.
 */
function textPatient(p, { kind, body }) {
  if (p.contact === "Call" || !p.phone) return false;
  sendSms({ to: p.phone, name: p.name, kind, body });
  return true;
}

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
  // A live practice writes the change to Postgres first; texts only go once it's safely saved.
  const saved = sb.flush && sb.flush();
  if (saved) saved.then(() => sends.forEach((f) => f()), () => console.error("texts held back: the change wasn't saved", sb.id));
  else sends.forEach((f) => f());
  return result;
}

function rank(slot, declined) {
  const clinician = getClinician(slot.clinicianId);
  const waitlist = all("SELECT * FROM waitlist WHERE status = 'waiting'").map(map.wait);
  const patientsById = Object.fromEntries(all("SELECT * FROM patients").map((r) => { const p = map.patient(r); p.nhsFrom = nhsFrom(p); return [r.id, p]; }));
  const leadMin = cal.workMinutesUntil(slot.day, slot.start, sandbox.nowMin()); // PCSE's 48 hours are working hours
  const r = rankCandidates({ slot, clinician, dayAppts: dayAppts(slot.clinicianId, slot.day).concat(slot), waitlist, patientsById, declined, sameDay: slot.day === 0, leadMin });
  // A third NHS sight test at one address that day needs 3 weeks' notice to PCSE: don't offer it inside that.
  for (const c of r.candidates) {
    if (!c.ok || !TYPES[c.type].pvn) continue;
    const problem = pvn.check({ patient: patientsById[c.patientId], type: c.type, day: slot.day, start: slot.start, exclude: slot.id });
    if (problem) { c.ok = false; c.score = 0; c.reason = `NHS test: PCSE needs ${problem.rule === "3 weeks" ? "3 weeks" : "48 hours"}' notice`; }
  }
  r.candidates.sort((a, b) => (b.ok - a.ok) || (b.score - a.score));
  return { clinician, ...r };
}

/* ---------- PCSE pre-visit notifications ---------- */
/**
 * Note what the office must do in PCSE Online for an NHS sight test: lodge a notification for a new visit,
 * or cancel the one for a visit that won't happen. Domi can't do it for them yet (that needs PCSE to accept
 * Domi as a practice system), so these are a checklist with the deadline worked out.
 */
function pcseTask(action, appt, patient) {
  if (!TYPES[appt.type].pvn) return;
  run("INSERT INTO pcse (action, patient_id, appointment_id, day, start_min, created_at) VALUES (?, ?, ?, ?, ?, ?)", action, patient.id, appt.id, appt.day, appt.start, sandbox.stamp());
  audit("system", "pcse." + action, appt.id, `${patient.name}, ${cal.label(appt.day)} ${hm(appt.start)}`);
}

/** The office's PCSE to-do list, oldest first, with the latest time each notification can be lodged. */
function pcseList() {
  return all("SELECT x.*, p.name FROM pcse x JOIN patients p ON p.id = x.patient_id WHERE x.created_at != '' ORDER BY x.status = 'done', x.id").map((r) => { // '' = notified before Domi
    const t = { ...map.pcse(r), name: r.name };
    if (t.action === "lodge") {
      const by = cal.lodgeBy(t.day, t.start, PVN_NOTICE_MIN); // 48 working hours before the visit
      t.lodgeBy = `${by.day < 0 ? "Before today" : cal.label(by.day)} ${hm(Math.min(by.min, 1439))}`;
    }
    return t;
  });
}

function completePcse(id, user) {
  return tx(() => {
    const r = one("SELECT * FROM pcse WHERE id = ?", Number(id));
    if (!r) throw new HttpError(404, "That PCSE task no longer exists.");
    if (r.status === "done") throw new HttpError(409, "That's already ticked off.");
    run("UPDATE pcse SET status = 'done', done_by = ? WHERE id = ?", user.name, r.id);
    audit(user.name, "pcse.done", String(r.id), `${r.action === "lodge" ? "Notification lodged" : "Notification cancelled"} for ${getPatient(r.patient_id).name}`);
    bus.emit({ type: "pcse.updated", pcseId: r.id });
    return { ok: true };
  });
}

/**
 * Every booking, move, cancellation and not-seen visit, kept for the office to copy into Opticabase's diary while
 * the two systems can't talk to each other. A snapshot: the dates are real dates, so they never need rolling.
 */
function diaryLog(change, a, { was = null, reason = null } = {}) {
  run("INSERT INTO diary_log (appointment_id, change, at, patient_id, visit_date, visit_time, clinician, type, was_date, was_time, was_clinician, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    a.id, change, `${cal.iso(0)} ${sandbox.stamp().slice(0, 5)}`, a.patientId, cal.iso(a.day), hm(a.start), getClinician(a.clinicianId).name, TYPES[a.type].name,
    was ? cal.iso(was.day) : null, was ? hm(was.start) : null, was ? was.clinician : null, reason);
}
/** Diary changes still to copy across (oldest first), and the latest ones already copied. */
function diaryChanges() {
  const row = (r) => { const p = getPatient(r.patient_id) || {}; return { id: r.id, appointmentId: r.appointment_id, change: r.change, at: r.at, obId: p.obId || null, patient: p.name, dob: p.dob || null, pc: p.pc,
    visitDate: r.visit_date, visitTime: r.visit_time, clinician: r.clinician, type: r.type, wasDate: r.was_date, wasTime: r.was_time, wasClinician: r.was_clinician, reason: r.reason, copiedAt: r.copied_at, copiedBy: r.copied_by }; };
  // Glasses sold at a visit go into Opticabase too (the order and any voucher claim are made there).
  const sale = (r) => { const p = getPatient(r.patient_id) || {}, a = getAppt(r.appointment_id) || {}, c = getClinician(r.clinician_id) || {};
    return { id: "s" + r.id, appointmentId: r.appointment_id, change: "sold", at: r.at, obId: p.obId || null, patient: p.name, dob: p.dob || null, pc: p.pc,
      visitDate: cal.iso(a.day || 0), visitTime: hm(a.start || 0), clinician: c.name, type: TYPES[a.type] ? TYPES[a.type].name : "",
      reason: [r.frames_pence && `Frames £${(r.frames_pence / 100).toFixed(2)}${r.frame_ref ? ` (${r.frame_ref})` : ""}`, r.lenses_pence && `Lenses £${(r.lenses_pence / 100).toFixed(2)}${r.lens_desc ? ` (${r.lens_desc})` : ""}`, r.voucher && "NHS voucher (GOS3)", "paid by card"].filter(Boolean).join("; "),
      copiedAt: r.copied_at, copiedBy: r.copied_by }; };
  const byAt = (x, y) => (x.at < y.at ? -1 : x.at > y.at ? 1 : 0);
  return { todo: all("SELECT * FROM diary_log WHERE copied_at IS NULL ORDER BY id").map(row).concat(all("SELECT * FROM sales WHERE sold = 1 AND copied_at IS NULL").map(sale)).sort(byAt),
    done: all("SELECT * FROM diary_log WHERE copied_at IS NOT NULL ORDER BY id DESC LIMIT 50").map(row).concat(all("SELECT * FROM sales WHERE sold = 1 AND copied_at IS NOT NULL ORDER BY id DESC LIMIT 20").map(sale)).sort(byAt).reverse() };
}
/** The office has put these changes into Opticabase: tick them off. */
function markDiaryCopied(ids, user) {
  return tx(() => {
    const raw = Array.isArray(ids) ? ids.map(String) : [];
    const list = raw.filter((x) => /^\d+$/.test(x)).map(Number), sold = raw.filter((x) => /^s\d+$/.test(x)).map((x) => Number(x.slice(1)));
    if (!list.length && !sold.length) throw new HttpError(400, "Choose the changes you've copied.");
    const at = `${cal.iso(0)} ${sandbox.stamp().slice(0, 5)}`;
    let n = 0;
    for (const id of list) n += run("UPDATE diary_log SET copied_at = ?, copied_by = ? WHERE id = ? AND copied_at IS NULL", at, user.name, id).changes;
    for (const id of sold) n += run("UPDATE sales SET copied_at = ?, copied_by = ? WHERE id = ? AND copied_at IS NULL", at, user.name, id).changes;
    audit(user.name, "diary.copied", "diary_log", `${n} diary change${n === 1 ? "" : "s"} copied to Opticabase`);
    bus.emit({ type: "appointment.updated" });
    return { copied: n };
  });
}
const declinedFor = (slotId) => all("SELECT waitlist_id FROM offers WHERE slot_id = ? AND status IN ('declined','expired')", slotId).map((r) => r.waitlist_id);
const pendingFor = (slotId) => all("SELECT * FROM offers WHERE slot_id = ? AND status = 'pending'", slotId);

/**
 * Cancel a visit and start refilling it. `byText` when the patient cancelled by SMS, `byLink` when they (or
 * their family) used the cancellation link.
 */
function cancelAppointment(id, reason, actor, { byText = false, byLink = false } = {}) {
  return tx(() => {
    const a = getAppt(id);
    if (!a) throw new HttpError(404, "That visit no longer exists.");
    if (!["booked", "enroute"].includes(a.status)) throw new HttpError(409, "Only visits that haven't started can be cancelled.");
    const p = getPatient(a.patientId);
    const c = getClinician(a.clinicianId);
    run("UPDATE appointments SET status = 'cancelled', reason = ?, cancelled_min = ? WHERE id = ?", reason, sandbox.nowMin(), id);
    audit(actor, "appointment.cancel", id, `${p.name} at ${hm(a.start)}: ${reason}`);
    pcseTask("cancel", a, p); // PCSE must be told an NHS visit won't happen, or the claim won't match
    diaryLog("cancelled", a, { reason });
    textPatient(p, { kind: "cancellation", body: byText || byLink
      ? `Thanks ${first(p.name)}, we've cancelled your visit ${when(a.day, a.start)}. We'll be in touch to rebook. ${practice()}`
      : `Hi ${first(p.name)}, your visit ${when(a.day, a.start)} has been cancelled (${reason.toLowerCase()}). We'll be in touch to rebook. ${practice()}` });
    sendSms({ to: "clinician", name: c.name, kind: "diary-change", toClinicianId: c.id, body: `${p.name} (${a.day === 0 ? "" : cal.label(a.day) + " "}${hm(a.start)}) has cancelled${byText ? " by text" : byLink ? " online" : ""}. ${a.day > cal.ahead("offerAheadDays") ? "The time is open for booking again." : "We're refilling the slot and will update you."}` });
    const result = offerNext(id, actor, { first: true });
    const evt = { ...result, cancelled: { patient: p.name, reason, byText, byLink } };
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
  // Far-off gaps aren't texted round: they stay open for normal booking (Settings, default 14 days).
  if (slot.day > cal.ahead("offerAheadDays")) {
    const why = `More than ${cal.ahead("offerAheadDays")} days away, so it's left open for normal booking`;
    run("UPDATE appointments SET gap = 1 WHERE id = ?", slotId);
    audit(actor, "slot.unfilled", slotId, `${cal.label(slot.day)} ${hm(slot.start)}: ${why}`);
    return { outcome: "unfilled", why, slotId, clinicianId: slot.clinicianId, day: slot.day, start: slot.start, candidates: [], plan: { mode: "none" } };
  }
  const { clinician, window, candidates } = rank(slot, declinedFor(slotId));
  // Phone mode: nobody is texted. The office gets the ranked list to ring, straight away.
  if (settings().mode === "phone") {
    const callable = candidates.filter((c) => c.ok);
    const why = callable.length ? `Ring the list: ${callable.length} ${callable.length === 1 ? "person fits" : "people fit"}, best match first` : "Nobody suitable on the waiting list";
    run("UPDATE appointments SET gap = 1 WHERE id = ?", slotId);
    audit(actor, "slot.call-list", slotId, `${cal.label(slot.day)} ${hm(slot.start)}: ${callable.length} to ring`);
    return { outcome: "call-list", why, slotId, clinicianId: slot.clinicianId, clinician: clinician.name, day: slot.day, start: slot.start, window, candidates: candidates.slice(0, 8), plan: { mode: "phone" }, now: sandbox.nowMin() };
  }
  const eligible = candidates.filter((c) => c.ok && !c.byPhone); // phone-only patients are rung by the office, never texted
  const ringable = candidates.filter((c) => c.ok && c.byPhone);
  const now = sandbox.nowMin();
  const plan = planOffer({ leadMin: slot.day * 1440 + slot.start - now, drive: slot.drive, offerMinutes: settings().offerMinutes, eligible: eligible.length });
  const base = { slotId, clinicianId: slot.clinicianId, clinician: clinician.name, day: slot.day, start: slot.start, window, candidates: candidates.slice(0, 5), plan, now };

  if (plan.mode === "none" || plan.mode === "too-late") {
    const why = plan.mode === "too-late" ? `Too close to the visit to confirm anyone (${Math.max(0, plan.slack)} min of slack)`
      : ringable.length ? `Nobody suitable can be texted. ${ringable.map((c) => c.name).slice(0, 2).join(" and ")} asked for calls: phone them and book from the list`
      : "Nobody suitable on the waiting list";
    run("UPDATE appointments SET gap = 1 WHERE id = ?", slotId);
    audit(actor, "slot.unfilled", slotId, `${hm(slot.start)}: ${why}`);
    if (!isFirst) bus.emit({ type: "slot.unfilled", ...base, why });
    return { outcome: "unfilled", why, ...base };
  }

  if (settings().mode === "instant") {
    const booking = book(slot, eligible[0].waitlistId, null, actor, "instant");
    return { outcome: "booked", top: eligible[0], booking, ...base };
  }

  const round = (one("SELECT MAX(round) AS r FROM offers WHERE slot_id = ?", slotId).r || 0) + 1;
  const deadline = hm(now + plan.windowMin);
  const chosen = eligible.slice(0, plan.count);
  const offers = chosen.map((cand) => {
    const p = getPatient(cand.patientId);
    const visit = `${when(slot.day, slot.start)} with ${clinician.first} (${lowerName(TYPES[cand.type].name)})`;
    const body = offerText(p.name, visit, deadline, plan.mode === "parallel");
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

/**
 * Put a waiting-list patient into a freed slot. `how`: "offer" (they replied YES), "instant" (instant mode) or
 * "office" (the office rang them and booked it).
 */
function book(slot, waitlistId, offerId, actor, how = offerId ? "offer" : "instant") {
  const w = map.wait(one("SELECT * FROM waitlist WHERE id = ?", waitlistId));
  const p = getPatient(w.patientId);
  const old = getPatient(slot.patientId);
  const c = getClinician(slot.clinicianId);
  const t = TYPES[w.type];
  const clash = one("SELECT id FROM appointments WHERE clinician_id = ? AND day = ? AND start_min = ? AND status != 'cancelled'", slot.clinicianId, slot.day, slot.start);
  if (clash) throw new HttpError(409, "That slot has already been filled.");
  const id = newId("n");
  const note = `${old.name} cancelled. ${p.name} (${lowerName(t.name)}) now booked ${when(slot.day, slot.start)}, ${p.addr}.`;
  run("INSERT INTO appointments (id, clinician_id, patient_id, type, day, start_min, drive, status, moved, note, booked_min, filled_from, source) VALUES (?, ?, ?, ?, ?, ?, ?, 'booked', 1, ?, ?, ?, ?)",
    id, slot.clinicianId, p.id, w.type, slot.day, slot.start, slot.drive, note, sandbox.nowMin(), slot.id, w.source === "recall" ? "recall" : sourceFor(p.id));
  run("UPDATE appointments SET gap = 0 WHERE id = ?", slot.id);
  pcseTask("lodge", getAppt(id), p);
  diaryLog("booked", getAppt(id), { reason: `Refilled ${old.name}'s cancelled visit` });
  run("UPDATE waitlist SET status = 'booked' WHERE id = ?", waitlistId);
  run("UPDATE recalls SET status = 'booked' WHERE waitlist_id = ?", waitlistId);
  if (offerId) run("UPDATE offers SET status = 'accepted', booked_appointment_id = ? WHERE id = ?", id, offerId);
  // Everyone else asked for this slot hears straight away that it has gone, and keeps their place.
  for (const o of pendingFor(slot.id)) {
    run("UPDATE offers SET status = 'superseded' WHERE id = ?", o.id);
    run("UPDATE waitlist SET status = 'waiting' WHERE id = ?", o.waitlist_id);
    const other = getPatient(map.wait(one("SELECT * FROM waitlist WHERE id = ?", o.waitlist_id)).patientId);
    sendSms({ to: other.phone, name: other.name, kind: "offer-taken", body: `Sorry ${first(other.name)}, the visit ${when(slot.day, slot.start)} has just been taken. You keep your place on our list. ${practice()}` });
  }
  addNote(p.id, `Moved forward from waiting list to ${cal.label(slot.day)} ${hm(slot.start)} with ${c.name}.`, { name: "Office" }, { silent: true });
  const patientBody = how === "instant"
    ? `Good news ${first(p.name)}: thanks to a cancellation, your home visit has moved forward to ${when(slot.day, slot.start).replace(/^today/, "TODAY")} with ${c.first}. Reply NO if you can't make it and we'll keep your place. ${practice()}`
    : `Thank you ${first(p.name)}, you're booked ${when(slot.day, slot.start)} with ${c.first}. We'll text when ${c.first} is on the way. ${practice()}`;
  textPatient(p, { kind: "confirmation", body: patientBody });
  sendSms({ to: "clinician", name: c.name, kind: "diary-change", toClinicianId: c.id, body: `Diary update: your ${slot.day === 0 ? "" : cal.label(slot.day) + " "}${hm(slot.start)} (${old.name}) cancelled. Now seeing ${p.name}, ${lowerName(t.name)}, ${p.addr} ${p.pc}. Record is in the app.` });
  audit(actor, "slot.filled", id, `${p.name} moved forward to ${hm(slot.start)} with ${c.name}${how === "office" ? " (booked by phone)" : ""}`);
  const booking = { appointmentId: id, patient: p.name, clinician: c.name, day: slot.day, start: slot.start, instant: how === "instant", byOffice: how === "office" };
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
      sendSms({ to: pr.phone, name: pr.name, kind: "clarify", body: `Sorry ${first(pr.name)}, we didn't catch that. Please reply YES to take the visit or NO to keep your place. ${practice()}` });
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
      const link = cancelLink(a.id);
      sendSms({ to: a.phone, name: a.pname, kind: "reminder", body: reminderText(a.pname, a.cfirst, day, a.start_min, a.type, link) });
      run("UPDATE appointments SET reminded = 1 WHERE id = ?", a.id);
    }
    if (due.length) {
      audit(actor, "reminders.sent", `day:${day}`, `${due.length} reminder${due.length === 1 ? "" : "s"} for ${cal.label(day)}`);
      bus.emit({ type: "reminders.sent", day, count: due.length });
    }
    return { day, sent: due.length };
  });
}

/** Sends reminders for the next working day (Monday's on a Friday) once the clock passes the reminder time. */
function sweepReminders() {
  const st = settings(), sb = sandbox.current();
  if (!st.reminders || sandbox.nowMin() < st.reminderAt || sb.remindedDay === 1) return;
  sb.remindedDay = 1;
  const next = cal.openDays(1, 1)[0];
  if (next != null) sendReminders(next);
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
      sendSms({ to: p.phone, name: p.name, kind: "offer-expired", body: `Hi ${first(p.name)}, replies for the visit ${when(slot.day, slot.start)} have now closed. You keep your place on our list. ${practice()}` });
      audit("system", "offer.expired", `offer:${o.id}`, `${p.name} did not reply by ${o.deadline}`);
      bus.emit({ type: "offer.expired", slotId: slot.id, clinicianId: null, patient: p.name, offerId: o.id });
      slots.add(slot.id);
    }
    for (const id of slots) if (!pendingFor(id).length) offerNext(id, "system");
  });
}

/* ---------- Sales at the visit: frames and lenses ---------- */
const NO_SALE = ["Not needed", "Price", "Wants to think about it", "Has glasses already"];
const pence = (v, what) => {
  if (v == null || v === "") return 0;
  const n = Math.round(Number(v) * 100);
  if (!Number.isFinite(n) || n < 0 || n > 500000) throw new HttpError(400, `Enter the ${what} price in pounds, up to £5,000.`);
  return n;
};
/** What was sold at a visit (frames, lenses, paid by card, an NHS voucher towards it), or why nothing was. One per visit. */
function recordSale(a, input, user) {
  if (!input || typeof input !== "object") throw new HttpError(400, "Say whether anything was sold.");
  const sold = input.sold === true;
  const frames = sold ? pence(input.frames, "frames") : 0, lenses = sold ? pence(input.lenses, "lenses") : 0;
  if (sold && !frames && !lenses) throw new HttpError(400, "Enter the price of the frames or the lenses.");
  const reason = sold ? null : NO_SALE.includes(input.reason) ? input.reason : null;
  if (!sold && !reason) throw new HttpError(400, "Choose why nothing was sold.");
  const clip = (v) => (v == null ? null : String(v).trim().slice(0, 120) || null);
  run("DELETE FROM sales WHERE appointment_id = ?", a.id);
  run(`INSERT INTO sales (appointment_id, patient_id, clinician_id, day, sold, frames_pence, frame_ref, lenses_pence, lens_desc, total_pence, voucher, method, reason, by_name, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, a.id, a.patientId, a.clinicianId, a.day, sold ? 1 : 0, frames, sold ? clip(input.frameRef) : null,
    lenses, sold ? clip(input.lensDesc) : null, frames + lenses, sold && input.voucher === true ? 1 : 0, sold ? "card" : null, reason, user.name, `${cal.iso(0)} ${sandbox.stamp().slice(0, 5)}`);
  const p = getPatient(a.patientId), c = getClinician(a.clinicianId);
  const what = [frames && "frames", lenses && "lenses"].filter(Boolean).join(" and ");
  audit(user.name, sold ? "sale.recorded" : "sale.none", a.id, sold ? `${p.name}: ${what}, £${((frames + lenses) / 100).toFixed(2)}` : `${p.name}: nothing sold (${reason})`);
  bus.emit({ type: "sale.recorded", appointmentId: a.id, clinicianId: c.id, clinician: c.first, patient: p.name, sold, what, totalPence: frames + lenses, reason });
  return saleOf(a.id);
}
const saleOf = (apptId) => { const r = one("SELECT * FROM sales WHERE appointment_id = ?", apptId); return r && map.sale(r); };
/** The office records or corrects the sale on a finished visit (when the clinician couldn't). */
function saveSale(id, input, user) {
  return tx(() => {
    const a = getAppt(String(id));
    if (!a) throw new HttpError(404, "That visit no longer exists.");
    if (a.status !== "done") throw new HttpError(409, "Sales are recorded once the visit is complete.");
    return recordSale(a, input, user);
  });
}

function setStatus(id, status, user, sale = null) {
  return tx(() => {
    const a = getAppt(id);
    if (!a) throw new HttpError(404, "That visit no longer exists.");
    if (user.role === "clinician" && a.clinicianId !== user.clinicianId) throw new HttpError(403, "This visit is on another clinician's round.");
    if (a.day !== 0) throw new HttpError(409, `That visit is on ${cal.label(a.day)}, not today.`);
    const flow = { booked: ["enroute"], enroute: ["live"], live: ["done"] };
    if (!(flow[a.status] || []).includes(status)) throw new HttpError(409, `A visit that is ${a.status} can't move to ${status}.`);
    if (status === "done" && sale) recordSale(a, sale, user); // checked before the visit is closed, so a bad price stops both
    run("UPDATE appointments SET status = ?, seen = 1 WHERE id = ?", status, id);
    const p = getPatient(a.patientId);
    const c = getClinician(a.clinicianId);
    if (status === "enroute") {
      sendSms({ to: p.phone, name: p.name, kind: "on-the-way", fromClinicianId: c.id, body: `Hi ${first(p.name)}, ${c.first} from ${practice()} is on the way and should be with you in about ${a.drive || 12} minutes.` });
    }
    audit(user.name, "appointment." + status, id, `${p.name} at ${hm(a.start)}`);
    const invoice = status === "done" ? raiseInvoice(getAppt(id), user) : null;
    bus.emit({ type: "appointment.updated", clinicianId: a.clinicianId, appointmentId: id, status });
    return { ...getAppt(id), invoice };
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
async function routeFor(cid, day, insert, { withPath = true } = {}) {
  const c = getClinician(String(cid || ""));
  if (!c) throw new HttpError(404, "No such clinician.");
  if (!(Number.isInteger(day) && day >= -14 && day <= cal.ahead("bookAheadDays"))) throw new HttpError(400, "Choose a day in the diary.");
  let stops = all("SELECT a.*, p.name, p.pc, p.addr FROM appointments a JOIN patients p ON p.id = a.patient_id WHERE a.clinician_id = ? AND a.day = ? AND a.status != 'cancelled' ORDER BY a.start_min", c.id, day)
    .map((r) => ({ id: r.id, name: r.name, pc: r.pc, addr: r.addr, type: r.type, start: r.start_min, end: r.start_min + TYPES[r.type].dur, status: r.status, moved: !!r.moved }));
  if (insert) {
    const pc = travel.normalise(insert.pc), type = TYPES[insert.type] ? insert.type : "follow", start = Number(insert.start);
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
  // The roads between the stops, for the map. Without it (offline routing, router down) the map draws straight lines.
  const path = withPath && stops.length ? await travel.roadPath([c.base, ...stops.map((s) => s.pc), c.base]) : null;
  return { clinician: { id: c.id, name: c.name, first: c.first, color: c.color }, day, base: { pc: c.base, ...travel.locate(c.base) }, stops, home, totals, districts, path };
}

/* ---------- Route planning ---------- */
/** A clinician's day, re-ordered to drive least (server/planner.js). Nothing changes until it's applied. */
async function planRoute(cid, day) {
  const c = getClinician(String(cid || ""));
  if (!c) throw new HttpError(404, "No such clinician.");
  bookableDay(day);
  const visits = all("SELECT a.*, p.name, p.pc FROM appointments a JOIN patients p ON p.id = a.patient_id WHERE a.clinician_id = ? AND a.day = ? AND a.status != 'cancelled' ORDER BY a.start_min", c.id, day)
    .map((r) => ({ id: r.id, name: r.name, pc: r.pc, dur: TYPES[r.type].dur, start: r.start_min, status: r.status, type: r.type, tw: r.tw ? { k: r.tw, at: r.tw_at } : null }));
  await travel.prepare([c.base, ...visits.map((v) => v.pc)]);
  const drive = (a, b) => (a === b ? 0 : travel.driveMinutes(a, b) || 15);
  const [dayStart, dayEnd] = hoursOn(c, day) || [settings().dayStart, settings().dayEnd];
  const plan = planner.planDay({ base: c.base, visits, drive, miles: travel.miles, now: day === 0 ? sandbox.nowMin() : null, dayStart, dayEnd });
  return { clinicianId: c.id, clinician: c.name, first: c.first, day, dayLabel: cal.label(day), ...plan };
}

/** Put a planned route into the diary, and text each patient whose time has changed. */
async function applyRoute(cid, day, user) {
  const plan = await planRoute(cid, day);
  return tx(() => {
    if (!plan.changed) return { ...plan, applied: false };
    // Re-check against the diary as it is now, so a visit booked or cancelled meanwhile isn't overwritten.
    const live = all("SELECT id, start_min, status FROM appointments WHERE clinician_id = ? AND day = ? AND status != 'cancelled'", plan.clinicianId, day);
    const ids = new Set(plan.fixed.map((f) => f.id).concat(plan.planned.map((p) => p.id)));
    if (live.length !== ids.size || live.some((r) => !ids.has(r.id) || (r.status !== "booked" && plan.planned.some((p) => p.id === r.id))))
      throw new HttpError(409, "The diary changed while you were looking. Plan the route again.");
    for (const p of plan.planned) {
      run("UPDATE appointments SET start_min = ?, drive = ? WHERE id = ?", p.start, p.drive || 0, p.id);
      if (!p.moved) continue;
      const a = getAppt(p.id), pt = getPatient(a.patientId);
      sendSms({ to: pt.phone, name: pt.name, kind: "time-change", body: `Hi ${first(pt.name)}, it's ${practice()}. Your home visit ${cal.phrase(day)} is now at ${hm(p.start)} (was ${hm(p.from)}). Reply NO if that doesn't suit.` });
    }
    sendSms({ to: "clinician", name: plan.clinician, kind: "diary-change", toClinicianId: plan.clinicianId, body: `Your route ${cal.phrase(day)} has been re-planned: ${plan.changed} visit${plan.changed === 1 ? "" : "s"} moved, about ${plan.savedMin} min less driving. The new order is in the app.` });
    audit(user.name, "route.planned", `${plan.clinicianId}:${day}`, `${plan.clinician} ${cal.label(day)}: ${plan.changed} moved, ${plan.savedMin} min and ${plan.savedMiles} miles saved`);
    bus.emit({ type: "route.planned", clinicianId: plan.clinicianId, day, savedMin: plan.savedMin });
    return { ...plan, applied: true };
  });
}

/* ---------- Invoicing ---------- */
const getInvoice = (id) => { const r = one("SELECT * FROM invoices WHERE id = ?", String(id)); if (!r) throw new HttpError(404, "Invoice not found."); return map.invoice(r); };

/** Raised when a visit is completed (inside its transaction), at the practice's price for that visit type. */
function raiseInvoice(a, user) {
  const price = Number((settings().prices || {})[a.type] || 0);
  if (price <= 0 || one("SELECT 1 FROM invoices WHERE appointment_id = ?", a.id)) return null;
  const n = one("SELECT COUNT(*) AS n FROM invoices").n + 1;
  const id = newId("i"), number = "INV-" + String(n).padStart(4, "0");
  const items = [{ desc: `${TYPES[a.type].name}, home visit ${cal.label(a.day)} ${hm(a.start)}`, pence: price * 100 }];
  run("INSERT INTO invoices (id, number, appointment_id, patient_id, items, total_pence, issued_at, issued_day) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    id, number, a.id, a.patientId, JSON.stringify(items), price * 100, sandbox.stamp(), a.day);
  audit(user.name, "invoice.raise", id, `${number} ${getPatient(a.patientId).name} £${price}`);
  bus.emit({ type: "invoice.updated", invoiceId: id });
  return { id, number, totalPence: price * 100 };
}

function payInvoice(id, method, user) {
  return tx(() => {
    const inv = getInvoice(id);
    if (inv.status !== "unpaid") throw new HttpError(409, `That invoice is already ${inv.status}.`);
    if (!["card", "cash", "bank"].includes(method)) throw new HttpError(400, "Choose card, cash or bank transfer.");
    run("UPDATE invoices SET status = 'paid', method = ?, paid_at = ? WHERE id = ?", method, sandbox.stamp(), inv.id);
    audit(user.name, "invoice.paid", inv.id, `${inv.number} by ${method}`);
    bus.emit({ type: "invoice.updated", invoiceId: inv.id });
    return getInvoice(inv.id);
  });
}

function voidInvoice(id, user) {
  return tx(() => {
    const inv = getInvoice(id);
    if (inv.status !== "unpaid") throw new HttpError(409, "Only unpaid invoices can be voided.");
    run("UPDATE invoices SET status = 'void' WHERE id = ?", inv.id);
    audit(user.name, "invoice.void", inv.id, inv.number);
    bus.emit({ type: "invoice.updated", invoiceId: inv.id });
    return getInvoice(inv.id);
  });
}

function invoiceList() {
  const list = all("SELECT * FROM invoices ORDER BY number DESC").map(map.invoice);
  const sum = (st) => list.filter((i) => i.status === st).reduce((t, i) => t + i.totalPence, 0);
  return { invoices: list, totals: { unpaidPence: sum("unpaid"), paidPence: sum("paid"), count: list.length } };
}

/* ---------- Reports: any period, everything the office is asked about ---------- */
/** The period a report covers, as day numbers (0 is today). Reports look back: nothing after today. */
function reportPeriod(input) {
  const today = 0, wd = cal.weekday(0), dom = Number(cal.iso(0).slice(8, 10));
  const P = { today: [0, 0, "Today"], week: [-Math.min(wd, 4), 0, "This week"], lastweek: [-wd - 7, -wd - 3, "Last week"], month: [-(dom - 1), 0, "This month"], last30: [-29, 0, "Last 30 days"] };
  if (input.period === "custom") {
    const f = cal.dayOf(String(input.from || "")), to = cal.dayOf(String(input.to || ""));
    if (!Number.isFinite(f) || !Number.isFinite(to) || f > to) throw new HttpError(400, "Choose a start date before the end date.");
    if (to > today) throw new HttpError(400, "Reports cover up to today.");
    if (to - f > 366) throw new HttpError(400, "Choose a year or less.");
    return { from: f, to, label: `${cal.label(f)} to ${cal.label(to)}`, key: "custom" };
  }
  const k = P[input.period] ? input.period : "week", [from, to, label] = P[k];
  return { from, to, label, key: k };
}
async function reports(input = {}) {
  const per = reportPeriod(input), { from, to } = per;
  const clinicians = all("SELECT * FROM clinicians ORDER BY rowid").map(map.clinician);
  const cname = Object.fromEntries(clinicians.map((c) => [c.id, c.name]));
  const appts = all("SELECT * FROM appointments WHERE day BETWEEN ? AND ?", from, to).map(map.appt);
  const sales = all("SELECT * FROM sales WHERE day BETWEEN ? AND ?", from, to).map(map.sale);
  const invoices = all("SELECT * FROM invoices WHERE issued_day BETWEEN ? AND ?", from, to).map(map.invoice);
  const done = appts.filter((a) => a.status === "done"), sold = sales.filter((s) => s.sold);
  const sum = (xs, k) => xs.reduce((n, x) => n + (x[k] || 0), 0);
  const pct = (a, b) => (b ? Math.round((a / b) * 100) : null);
  const count = (xs, key) => { const m = {}; xs.forEach((x) => { const k = key(x) || "Not recorded"; m[k] = (m[k] || 0) + 1; }); return Object.entries(m).sort((x, y) => y[1] - x[1]).map(([label, n]) => ({ label, n })); };

  // Mileage: each clinician's planned route on each open day of the period (estimates from postcodes and road times).
  const miles = [], first = (one("SELECT MIN(day) AS d FROM appointments") || {}).d;
  for (const c of clinicians) {
    let driveMin = 0, m = 0, visits = 0, bookedMin = 0, workingMin = 0;
    for (let d = Math.max(from, first == null ? from : first); d <= to; d++) { // days before the diary began don't count as empty days
      if (!cal.isOpen(d)) continue;
      const h = hoursOn(c, d); workingMin += h ? h[1] - h[0] : 0;
      if (!appts.some((a) => a.clinicianId === c.id && a.day === d && a.status !== "cancelled")) continue;
      const r = await routeFor(c.id, d, null, { withPath: false });
      driveMin += r.totals.driveMin; m += r.totals.miles; visits += r.totals.visits; bookedMin += r.stops.reduce((t, s) => t + (s.end - s.start), 0);
    }
    if (!visits && !c.active) continue;
    miles.push({ clinicianId: c.id, name: c.name, visits, driveMin, miles: Math.round(m * 10) / 10, mileagePence: Math.round(m * HMRC_PENCE_PER_MILE), utilisation: pct(bookedMin, workingMin) });
  }

  const byClin = clinicians.map((c) => {
    const d = done.filter((a) => a.clinicianId === c.id), s = sold.filter((x) => x.clinicianId === c.id);
    return { clinicianId: c.id, name: c.name, visits: d.length, missed: appts.filter((a) => a.clinicianId === c.id && a.status === "missed").length,
      sales: s.length, conversion: pct(s.length, d.length), salesPence: sum(s, "totalPence"), avgSalePence: s.length ? Math.round(sum(s, "totalPence") / s.length) : null };
  }).filter((r) => r.visits || r.sales || r.missed);

  const days = [];
  for (let d = from; d <= to; d++) {
    if (!cal.isOpen(d)) continue;
    const ds = sold.filter((s) => s.day === d);
    days.push({ day: d, iso: cal.iso(d), label: cal.label(d), visits: done.filter((a) => a.day === d).length, cancelled: appts.filter((a) => a.day === d && a.status === "cancelled").length, sales: ds.length, salesPence: sum(ds, "totalPence") });
  }
  const leads = all("SELECT status, COUNT(*) AS n FROM leads GROUP BY status").reduce((m, r) => ({ ...m, [r.status]: r.n }), {});
  return {
    period: { ...per, fromIso: cal.iso(from), toIso: cal.iso(to) },
    summary: {
      visitsDone: done.length, patientsSeen: new Set(done.map((a) => a.patientId)).size, missed: appts.filter((a) => a.status === "missed").length,
      cancelled: appts.filter((a) => a.status === "cancelled").length, refilled: appts.filter((a) => a.moved).length,
      salesPence: sum(sold, "totalPence"), sales: sold.length, conversion: pct(sold.length, done.length), avgSalePence: sold.length ? Math.round(sum(sold, "totalPence") / sold.length) : null,
      miles: Math.round(sum(miles, "miles") * 10) / 10, mileagePence: sum(miles, "mileagePence"), driveMin: sum(miles, "driveMin"),
    },
    finance: {
      salesPence: sum(sold, "totalPence"), framesPence: sum(sold, "framesPence"), lensesPence: sum(sold, "lensesPence"), sales: sold.length, vouchers: sold.filter((s) => s.voucher).length,
      noSale: count(sales.filter((s) => !s.sold), (s) => s.reason), notRecorded: done.filter((a) => !sales.some((s) => s.appointmentId === a.id) && a.type !== "follow").length,
      invoiced: { n: invoices.filter((i) => i.status !== "void").length, pence: sum(invoices.filter((i) => i.status !== "void"), "totalPence"),
        paidPence: sum(invoices.filter((i) => i.status === "paid"), "totalPence"), unpaidPence: sum(invoices.filter((i) => i.status === "unpaid"), "totalPence") },
      recoveredPence: appts.filter((a) => a.moved).length * Number(settings().fee || 0) * 100,
    },
    byClinician: byClin,
    visits: {
      byType: Object.keys(TYPES).map((k) => ({ type: k, label: TYPES[k].name, done: done.filter((a) => a.type === k).length, missed: appts.filter((a) => a.type === k && a.status === "missed").length, cancelled: appts.filter((a) => a.type === k && a.status === "cancelled").length })).filter((r) => r.done || r.missed || r.cancelled),
      bySource: count(done, (a) => (SOURCES[a.source] || SOURCES.new).label),
      cancelReasons: count(appts.filter((a) => a.status === "cancelled"), (a) => a.reason),
      nhsSightTests: done.filter((a) => TYPES[a.type].pvn).length,
    },
    mileage: { ratePence: HMRC_PENCE_PER_MILE, clinicians: miles },
    days,
    // Line by line, for checking against the card reader and Opticabase: every sale and every visit in the period.
    lists: (() => {
      const pt = (id) => getPatient(id) || {}, ap = Object.fromEntries(appts.map((a) => [a.id, a]));
      const saleBy = Object.fromEntries(sales.map((s) => [s.appointmentId, s]));
      const STATUS = { done: "Done", missed: "Nobody in", cancelled: "Cancelled", booked: "Booked", enroute: "On the way", live: "With patient" };
      return {
        sales: sold.slice().sort((x, y) => (x.at < y.at ? -1 : 1)).map((s) => { const a = ap[s.appointmentId] || {}, p = pt(s.patientId);
          return { date: cal.iso(s.day), time: hm(a.start || 0), clinician: cname[s.clinicianId] || "", patient: p.name || "", obId: p.obId || "", type: TYPES[a.type] ? TYPES[a.type].name : "",
            framesPence: s.framesPence, frameRef: s.frameRef || "", lensesPence: s.lensesPence, lensDesc: s.lensDesc || "", voucher: s.voucher, totalPence: s.totalPence, method: s.method || "card", inOpticabase: !!s.copiedAt }; }),
        visits: appts.slice().sort((x, y) => x.day - y.day || x.start - y.start).map((a) => { const p = pt(a.patientId), s = saleBy[a.id];
          return { date: cal.iso(a.day), time: hm(a.start), clinician: cname[a.clinicianId] || "", patient: p.name || "", obId: p.obId || "", type: TYPES[a.type] ? TYPES[a.type].name : "",
            status: STATUS[a.status] || a.status, refill: !!a.moved, source: (SOURCES[a.source] || SOURCES.new).label, reason: a.status === "cancelled" ? a.reason || "" : "",
            sold: s ? (s.sold ? "Yes" : "No") : "", salePence: s && s.sold ? s.totalPence : null, noSaleReason: s && !s.sold ? s.reason || "" : "" }; }),
      };
    })(),
    now: { leads, waiting: one("SELECT COUNT(*) AS n FROM waitlist WHERE status = 'waiting'").n, recallsDue: one("SELECT COUNT(*) AS n FROM recalls WHERE status IN ('due','texted') AND due_day <= 0").n,
      pcseToDo: one("SELECT COUNT(*) AS n FROM pcse WHERE status = 'todo'").n, toCopy: one("SELECT COUNT(*) AS n FROM diary_log WHERE copied_at IS NULL").n + one("SELECT COUNT(*) AS n FROM sales WHERE sold = 1 AND copied_at IS NULL").n },
  };
}

/* ---------- Mileage and utilisation ---------- */
const HMRC_PENCE_PER_MILE = 45; // HMRC approved mileage rate for cars (first 10,000 business miles a year)

/** The week per clinician and day: visits, time booked against the working day, driving, miles and their mileage value. */
async function weekReport() {
  // Utilisation is measured against each clinician's own working hours; a day off counts as no working time.
  const clinicians = all("SELECT * FROM clinicians ORDER BY rowid").map(map.clinician).filter((c) => c.active || one("SELECT 1 FROM appointments WHERE clinician_id = ? AND status != 'cancelled'", c.id));
  const rows = [];
  for (const c of clinicians) {
    const days = [];
    for (const d of cal.thisWeek()) {
      const r = await routeFor(c.id, d, null, { withPath: false });
      const booked = r.stops.reduce((t, s) => t + (s.end - s.start), 0);
      const h = hoursOn(c, d), working = h ? h[1] - h[0] : 0;
      days.push({ day: d, dayLabel: cal.label(d), visits: r.totals.visits, bookedMin: booked, workingMin: working, utilisation: working ? Math.round((booked / working) * 100) : 0,
        driveMin: r.totals.driveMin, miles: r.totals.miles, mileagePence: Math.round(r.totals.miles * HMRC_PENCE_PER_MILE) });
    }
    const sum = (k) => days.reduce((t, x) => t + x[k], 0);
    rows.push({ clinicianId: c.id, name: c.name, first: c.first, color: c.color, days,
      total: { visits: sum("visits"), bookedMin: sum("bookedMin"), workingMin: sum("workingMin"), utilisation: sum("workingMin") ? Math.round((sum("bookedMin") / sum("workingMin")) * 100) : 0,
        driveMin: sum("driveMin"), miles: Math.round(sum("miles") * 10) / 10, mileagePence: sum("mileagePence") } });
  }
  const t = (k) => rows.reduce((a, r) => a + r.total[k], 0);
  return { ratePence: HMRC_PENCE_PER_MILE, clinicians: rows,
    practice: { visits: t("visits"), driveMin: t("driveMin"), miles: Math.round(t("miles") * 10) / 10, mileagePence: t("mileagePence"),
      utilisation: Math.round((t("bookedMin") / t("workingMin")) * 100), roadShare: Math.round((t("driveMin") / t("workingMin")) * 100) }, metrics: metrics() };
}

/* ---------- Recalls ---------- */
const getRecall = (id) => { const r = one("SELECT * FROM recalls WHERE id = ?", String(id)); if (!r) throw new HttpError(404, "Recall not found."); return map.recall(r); };

/** Text a recall patient a link to book their own visit. They stay in the refill pool meanwhile. */
/** The recall text, with the practice's own booking page. Also shown on the Settings page. */
const recallText = (name, reason, url) => `Hi ${first(name)}, it's ${practice()}. Your ${lowerName(reason)} is due. Book a home visit at a time that suits you: ${url} We'll also text you if a visit near you comes up sooner.`;
/**
 * Recalls sent by Domi, once a day at the practice's recall time: everyone due within a fortnight (or overdue)
 * who takes texts and hasn't been texted yet. Patients who'd rather be phoned stay on the list for the office.
 */
function sweepRecalls() {
  const st = settings(), sb = sandbox.current();
  if (!st.autoRecalls || sandbox.nowMin() < st.recallAt || sb.recalledDay === 1) return;
  sb.recalledDay = 1;
  const url = `${sb.base || process.env.PUBLIC_URL || ""}/book/${sb.id}`;
  const due = all("SELECT r.id FROM recalls r JOIN patients p ON p.id = r.patient_id WHERE r.status = 'due' AND r.due_day <= 14 AND p.contact = 'Text' AND p.erased = 0").map((x) => x.id);
  for (const id of due) textRecall(id, url, { name: "Domi (automatic)" });
}
function textRecall(id, bookingUrl, user) {
  return tx(() => {
    const r = getRecall(id);
    if (!["due", "texted"].includes(r.status)) throw new HttpError(409, "That recall is already booked or removed.");
    const p = getPatient(r.patientId);
    sendSms({ to: p.phone, name: p.name, kind: "recall", body: recallText(p.name, r.reason, bookingUrl) });
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
  const since = -cal.weekday(0); // "this week": from Monday (day numbers count from today)
  const cancelled = all("SELECT * FROM appointments WHERE status = 'cancelled' AND day >= ?", since).map(map.appt);
  const filled = all("SELECT * FROM appointments WHERE moved = 1 AND day >= ?", since).map(map.appt);
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
      : "Choose the town and postcode area (or type a full postcode), so we can work out travel.");
  }
  return { id: null, name, pc, addr: String(input.addr || "").trim() || "Address to confirm", phone: String(input.phone || "").trim() || "07700 900000", alerts: [] };
}

/** Where a visit could go this week. `exclude`: a visit being moved, so its current time counts as free. */
function slotsFor(patient, type, avail, { exclude = null, from = 0, count = 10, max = cal.ahead("bookAheadDays"), pvnApproved = false, tw } = {}) {
  if (!TYPES[type]) throw new HttpError(400, "Choose a visit type.");
  const clinicians = all("SELECT * FROM clinicians WHERE active = 1 ORDER BY id").map(map.clinician);
  const appts = all(`SELECT a.*, p.pc, p.name FROM appointments a JOIN patients p ON p.id = a.patient_id WHERE a.status != 'cancelled' AND a.id IS NOT ?`, exclude)
    .map((r) => ({ ...map.appt(r), pc: r.pc, name: r.name }));
  const wait = patient.id && one("SELECT prio FROM waitlist WHERE patient_id = ? AND status = 'waiting'", patient.id);
  // `count` open days from `from`: today onwards by default, or the week the office picked.
  const f = TYPES[type].pvn && patient.id && !patient.early ? nhsFrom(patient) : null;
  if (f && f.day > from) from = f.day; // not before their recall line
  const days = cal.openDays(from, count, max);
  // Only times the patient can do: the visit's own restriction when it's being moved, otherwise the patient's standing one.
  if (tw === undefined) tw = patient.id ? (getPatient(patient.id) || {}).tw || null : null;
  return suggestSlots({ pc: patient.pc, type, avail: ["am", "pm"].includes(avail) ? avail : "any", clinicians, appts, days, now: sandbox.nowMin(), prio: wait ? wait.prio : "routine", pvnApproved })
    .filter((s) => twAllows(tw, s.start));
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

/** Where a search starts: `date` (YYYY-MM-DD) or `from` (a day number), never before today or past the limit. */
function searchFrom(input, max = cal.ahead("bookAheadDays"), min = 0) {
  const d = input.date ? cal.dayOf(input.date) : Number(input.from || 0);
  if (!Number.isFinite(d)) return min;
  if (d > max) throw new HttpError(400, `Bookings can be made up to ${Math.round(max / 30.4) >= 2 ? Math.round(max / 30.4) + " months" : max + " days"} ahead.`);
  return Math.max(min, Math.round(d));
}

/** Ranked options for the booking screen. */
async function findSlots(input) {
  await warmRoutes(input);
  const patient = bookingPatient(input);
  const from = searchFrom(input);
  if (input.early === true) patient.early = true;
  const line = TYPES[input.type] && TYPES[input.type].pvn && !patient.early ? nhsFrom(patient) : null;
  const slots = slotsFor(patient, input.type, input.avail, { from, pvnApproved: !!icbOf(input) }).slice(0, 6);
  return { patient: { id: patient.id, name: patient.name, pc: patient.pc }, type: input.type, from, fromLabel: cal.label(from), slots,
    recallLine: line && line.day > from ? { label: line.label, day: line.day, months: line.months } : null };
}

/** Book a visit into a slot. The slot is re-checked here, so two people can't book the same gap. */
async function bookVisit(input, user) {
  await warmRoutes(input);
  return tx(() => {
    const draft = bookingPatient(input);
    const c = getClinician(String(input.clinicianId || ""));
    if (!c) throw new HttpError(400, "Choose a clinician.");
    const start = Number(input.start), day = bookableDay(Number(input.day || 0));
    checkNhsLine(draft, input.type, day, input.early === true);
    if (input.early === true) draft.early = true;
    const icb = icbOf(input);
    checkPvn(draft, input.type, day, start, icb);
    const slot = slotsFor(draft, input.type, input.avail, { from: day, count: 1, pvnApproved: !!icb }).find((x) => x.clinicianId === c.id && x.day === day && x.start === start);
    if (!slot) throw new HttpError(409, "That slot has just gone. Search again for the latest options.");
    return placeVisit({ draft, c, type: input.type, day, start, slot, actor: user.name, by: "the office", source: input.source, icb, early: input.early === true });
  });
}

/** Write a new visit into a round (inside a transaction): patient if new, appointment, next leg, texts, audit, event. */
function placeVisit({ draft, c, type, day, start, slot, actor, by, source, icb = null, early = false }) {
  const problem = checkPvn(draft, type, day, start, icb); // every route in: office, online booking
  let p = draft;
  if (!draft.id) {
    const id = newId("p");
    run("INSERT INTO patients (id, name, age, addr, pc, phone) VALUES (?, ?, NULL, ?, ?, ?)", id, draft.name, draft.addr, draft.pc, draft.phone);
    p = getPatient(id);
  }
  const t = TYPES[type];
  const id = newId("v");
  const note = `New visit booked by ${by}: ${p.name} (${lowerName(t.name)}) ${when(day, start)}, ${p.addr}.`;
  run("INSERT INTO appointments (id, clinician_id, patient_id, type, day, start_min, drive, status, note, booked_min, source) VALUES (?, ?, ?, ?, ?, ?, ?, 'booked', ?, ?, ?)",
    id, c.id, p.id, type, day, start, slot.driveIn, note, sandbox.nowMin(), sourceFor(draft.id ? p.id : null, source || (by === "the patient online" ? "new" : null)));
  if (problem || early) run("UPDATE appointments SET pvn_icb = ?, pvn_early = ? WHERE id = ?", problem ? icb : null, early ? 1 : 0, id);
  if (p.tw) run("UPDATE appointments SET tw = ?, tw_at = ? WHERE id = ?", p.tw.k, p.tw.at, id); // their standing restriction comes with them
  if (problem) audit(actor, "pcse.short-notice", id, `${p.name}: inside PCSE's ${problem.rule} notice, approved by ${icb} (ICB)`);
  // The visit after this one is now reached from the new patient's house.
  const after = one("SELECT id FROM appointments WHERE clinician_id = ? AND day = ? AND status != 'cancelled' AND start_min > ? ORDER BY start_min LIMIT 1", c.id, day, start);
  if (after) run("UPDATE appointments SET drive = ? WHERE id = ?", slot.driveOut, after.id);
  pcseTask("lodge", getAppt(id), p);
  diaryLog("booked", getAppt(id), { reason: by === "the office" ? null : "Booked online by the patient" });
  run("UPDATE waitlist SET status = 'booked' WHERE patient_id = ? AND status = 'waiting'", p.id);
  run("UPDATE recalls SET status = 'booked' WHERE patient_id = ? AND status IN ('due','texted')", p.id);
  addNote(p.id, `Booked by ${by} for ${cal.label(day)} at ${hm(start)} with ${c.name}.`, { name: actor }, { silent: true });
  sendSms({ to: p.phone, name: p.name, kind: "confirmation", body: `Hi ${first(p.name)}, your home visit from ${practice()} is booked ${when(day, start)} with ${c.first}. Reply CANCEL if you can't make it.` });
  sendSms({ to: "clinician", name: c.name, kind: "diary-change", toClinicianId: c.id, body: `New visit${by === "the office" ? "" : " (booked online)"}: ${p.name}, ${lowerName(t.name)}, ${cal.label(day)} ${hm(start)} at ${p.addr} ${p.pc}. About ${slot.driveIn} min from your previous visit.` });
  audit(actor, "appointment.book", id, `${p.name} ${cal.label(day)} ${hm(start)} with ${c.name} (+${slot.extraDrive} min driving)`);
  bus.emit({ type: "appointment.booked", clinicianId: c.id, appointmentId: id, patient: p.name, day, start, extraDrive: slot.extraDrive, online: by !== "the office" });
  return { appointmentId: id, patientId: p.id, patient: p.name, clinician: c.name, clinicianId: c.id, day, start, label: slot.label, dayLabel: cal.label(day), extraDrive: slot.extraDrive };
}

/* ---------- Importing patients from a spreadsheet ---------- */
/** Patients already on Domi, with what an import compares and can update. Erased records are left out. */
const existingPatients = () => all("SELECT id, name, pc, phone, dob, addr, email, eligibility, rep, last_test, next_exam, recall_months, ob_id, nhs_no, premises FROM patients WHERE erased = 0")
  .map((r) => ({ id: r.id, name: r.name, pc: r.pc, phone: r.phone, dob: r.dob, addr: r.addr, email: r.email, eligibility: r.eligibility, rep: r.rep,
    lastTest: r.last_test, nextExam: r.next_exam, recallMonths: r.recall_months, obId: r.ob_id, nhsNo: r.nhs_no, premises: r.premises }));
const IMPORT_COLS = { name: "name", dob: "dob", addr: "addr", pc: "pc", phone: "phone", email: "email", eligibility: "eligibility", rep: "rep",
  lastTest: "last_test", nextExam: "next_exam", recallMonths: "recall_months", nhsNo: "nhs_no", premises: "premises", obId: "ob_id" };
function checkImport(input) {
  const region = sandbox.current().brand.region;
  try { return importer.check(input.csv, input.mapping, existingPatients(), { townOf: (d) => regions.townOf(region, d) }); }
  catch (e) { throw new HttpError(400, e.message); }
}

/** What the office sees before anything is saved: the column mapping, counts, and every row with its problems. */
function previewImport(input) {
  const r = checkImport(input);
  return { fields: importer.FIELDS, headers: r.headers, samples: r.samples, mapping: r.mapping, missing: r.missing, counts: r.counts,
    rows: r.rows.map((x) => ({ line: x.line, status: x.status, name: x.patient.name, pc: x.patient.pc, phone: x.patient.phone, age: x.patient.age,
      errors: x.errors, warnings: x.warnings, duplicateOf: x.duplicateOf, recallDue: x.recall ? x.recall.dueDay : null,
      changes: x.changes, conflict: x.conflict || null })) };
}

/**
 * Save the rows that passed. The file is checked again here, so what's saved is exactly what the checks allow,
 * even if the preview was edited or is out of date. Patients due a sight test within a fortnight (or overdue)
 * also join the recall list and the refill pool, the same as any other recall.
 */
function commitImport(input, user) {
  return tx(() => {
    const r = checkImport(input);
    if (r.missing.length) throw new HttpError(400, `Choose which column holds ${r.missing.join(" and ")}.`);
    const ready = r.rows.filter((x) => x.status === "ready"), updates = r.rows.filter((x) => x.status === "update");
    if (!ready.length && !updates.length) throw new HttpError(400, "There's nothing to import: every row is already up to date on Domi, or has a problem.");
    // Patients already on Domi: only what changed in Opticabase is written, and the record says so.
    let updated = 0, skipped = 0;
    for (const row of updates) {
      const cur = one("SELECT id, erased FROM patients WHERE id = ?", row.patientId);
      const nhs = row.changes.find((c) => c.field === "nhsNo");
      if (!cur || cur.erased || (nhs && one("SELECT 1 FROM patients WHERE nhs_no = ? AND id != ?", nhs.to, cur.id))) { skipped++; continue; }
      for (const c of row.changes) run(`UPDATE patients SET ${IMPORT_COLS[c.field]} = ? WHERE id = ?`, c.field === "recallMonths" ? Number(c.to) : c.to, cur.id);
      if (row.changes.some((c) => c.field === "dob")) run("UPDATE patients SET age = ? WHERE id = ?", row.patient.age, cur.id);
      run("INSERT INTO notes (patient_id, label, body, author, created_at) VALUES (?, ?, ?, ?, ?)", cur.id, "Updated from Opticabase",
        `Changed by the import: ${row.changes.map((c) => c.label).join(", ")}.`, user.name, sandbox.stamp());
      updated++;
    }
    let recalls = 0;
    const seq = one("SELECT COALESCE(MAX(added_seq), 0) AS s FROM waitlist").s;
    for (const row of ready) {
      const p = row.patient, id = newId("p");
      run("INSERT INTO patients (id, name, age, addr, pc, phone, contact, alerts, specs, dob, email, eligibility, rep, last_test, next_exam, recall_months, ob_id, nhs_no, premises) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        id, p.name, p.age, p.addr, p.pc, p.phone, p.contact, JSON.stringify(p.alerts), p.specs, p.dob, p.email, p.eligibility, p.rep, p.lastTest, p.nextExam || null, p.recallMonths || null, p.obId || null, p.nhsNo || null, p.premises || null);
      run("INSERT INTO notes (patient_id, label, body, author, created_at) VALUES (?, ?, ?, ?, ?)", id, "Imported", p.notes ? `Imported from spreadsheet. ${p.notes}` : "Imported from spreadsheet.", user.name, sandbox.stamp());
      if (row.recall && row.recall.dueDay <= 14) {
        const rid = newId("r"), wid = newId("w");
        run("INSERT INTO waitlist (id, patient_id, type, prio, days, avail, short_notice, added_seq, source, note) VALUES (?, ?, 'sight', 'routine', ?, 'any', 1, ?, 'recall', ?)",
          wid, id, Math.max(0, -row.recall.dueDay), seq + 1 + recalls, row.recall.reason);
        run("INSERT INTO recalls (id, patient_id, type, reason, due_day, waitlist_id) VALUES (?, ?, 'sight', ?, ?, ?)", rid, id, row.recall.reason, row.recall.dueDay, wid);
        recalls++;
      }
    }
    // Counts only: patient details never go into the audit log or the event stream.
    audit(user.name, "patients.import", "patients", `${ready.length} imported, ${updated} updated, ${r.counts.same} unchanged, ${r.counts.conflict + skipped} not matched, ${r.counts.duplicate} duplicates and ${r.counts.error} with errors skipped, ${recalls} recalls`);
    bus.emit({ type: "patients.imported", count: ready.length + updated });
    return { imported: ready.length, updated, same: r.counts.same, conflicts: r.counts.conflict + skipped, duplicates: r.counts.duplicate, errors: r.counts.error, recalls };
  });
}

/* ---------- Referrals: the website form instead of documents ---------- */
const REF_FROM = { self: "The patient", family: "Family or a friend", carer: "A carer", carehome: "A care home", professional: "A GP or other professional" };
const REF_NEED = { sight: "An eye test", dispense: "New glasses fitted", repair: "A glasses repair or adjustment", follow: "A recheck" };
const ENTITLEMENT = { "60+": "Aged 60 or over", benefits: "Receives a qualifying benefit", diabetes: "Has diabetes", glaucoma: "Has glaucoma", "glaucoma-family": "40+ with glaucoma in the family", sight: "Registered partially sighted or blind", hc2: "HC2 certificate" };
const GENERIC_REASON = /^(house ?bound|bed ?bound|immobile|elderly|frail|can'?t get out|wheelchair)\.?$/i;
const clean = (v, max) => String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

/** A referral from the public form. It waits for the office: nothing becomes a patient record on its own. */
function submitReferral(input) {
  const fromKind = input.fromKind in REF_FROM ? input.fromKind : null;
  if (!fromKind) throw new HttpError(400, "Please say who is making the referral.");
  const name = clean(input.name, 80), addr = clean(input.addr, 120), notes = clean(input.notes, 1000), eligibility = clean(input.eligibility, 200);
  if (name.length < 2) throw new HttpError(400, "Please enter the patient's full name.");
  if (addr.length < 4) throw new HttpError(400, "Please enter the first line of the patient's address.");
  const pc = travel.normalise(input.pc);
  if (!travel.known(pc)) throw new HttpError(400, "Please choose the town and postcode area.");
  if (eligibility.length < 3) throw new HttpError(400, "Please tell us why the patient can't get to an optician's without help.");
  if (GENERIC_REASON.test(eligibility)) throw new HttpError(400, `Please tell us the illness or condition behind "${eligibility}". The NHS asks us to record it.`);
  const phoneOf = (v) => { const d = String(v || "").replace(/[\s()-]/g, "").replace(/^\+44/, "0"); return /^0\d{9,10}$/.test(d) ? d.replace(/^(\d{5})(\d+)$/, "$1 $2") : null; };
  const phone = phoneOf(input.phone), fromPhone = fromKind === "self" ? null : phoneOf(input.fromPhone);
  if (!phone && !fromPhone) throw new HttpError(400, "Please give a phone number we can call about the visit.");
  const fromName = fromKind === "self" ? null : clean(input.fromName, 80);
  if (fromKind !== "self" && fromName.length < 2) throw new HttpError(400, "Please give your name, so we know who to call back.");
  const need = input.need in REF_NEED ? input.need : "sight";
  const dob = /^\d{4}-\d{2}-\d{2}$/.test(String(input.dob || "")) ? input.dob : null;
  if (input.consent !== true) throw new HttpError(400, "Please confirm the patient agrees to us contacting them (or that you can act for them).");
  const entitlement = (Array.isArray(input.entitlement) ? input.entitlement : []).filter((k) => k in ENTITLEMENT).slice(0, 8);
  return tx(() => {
    const id = newId("rf");
    run("INSERT INTO referrals (id, created_at, from_kind, from_name, from_phone, name, dob, addr, pc, phone, eligibility, entitlement, need, avail, urgent, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      id, sandbox.stamp().slice(0, 5), fromKind, fromName, fromPhone, name, dob, addr, pc, phone, eligibility, JSON.stringify(entitlement), need, ["am", "pm"].includes(input.avail) ? input.avail : "any", input.urgent ? 1 : 0, notes || null);
    audit("Referral form", "referral.received", id, `From ${REF_FROM[fromKind].toLowerCase()}`); // no patient details in the audit line
    bus.emit({ type: "referral.updated", referralId: id, fresh: true });
    return { ok: true };
  });
}

const getReferral = (id) => { const r = one("SELECT * FROM referrals WHERE id = ?", String(id)); if (!r) throw new HttpError(404, "That referral no longer exists."); return map.referral(r); };

/** Accept: the patient record and a waiting-list place are made from the form, and whoever gave a number is texted. */
function acceptReferral(id, input, user) {
  return tx(() => {
    const r = getReferral(id);
    if (r.status !== "new") throw new HttpError(409, `That referral was already ${r.status}.`);
    const type = TYPES[input.type] ? input.type : r.need in TYPES ? r.need : "sight";
    const prio = ["urgent", "soon", "routine"].includes(input.prio) ? input.prio : r.urgent ? "urgent" : "routine";
    const dup = all("SELECT id, name FROM patients").find((p) => p.name.toLowerCase() === r.name.toLowerCase() && one("SELECT 1 FROM patients WHERE id = ? AND replace(pc, ' ', '') = ?", p.id, r.pc.replace(/\s/g, "")));
    if (dup && !input.anyway) throw new HttpError(409, `${dup.name} at ${r.pc} is already on Domi. Open their record instead, or accept anyway.`);
    const pid = newId("p");
    const age = r.dob ? Math.floor((cal.todayMs() - Date.parse(r.dob)) / (365.25 * 864e5)) : null;
    const mobile = r.phone && /^07/.test(r.phone);
    const rep = r.fromKind === "self" ? null : [r.fromName, r.fromPhone].filter(Boolean).join(", ");
    run("INSERT INTO patients (id, name, age, addr, pc, phone, contact, alerts, dob, eligibility, rep) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      pid, r.name, age, r.addr, r.pc, r.phone || r.fromPhone || "", mobile ? "Text" : "Call", JSON.stringify(rep && r.fromKind === "carehome" ? ["Care home: arrange through " + r.fromName] : []), r.dob, r.eligibility, rep);
    const ent = r.entitlement.map((k) => ENTITLEMENT[k]).join("; ");
    addNote(pid, `Referred by ${r.fromKind === "self" ? "themselves" : `${REF_FROM[r.fromKind].toLowerCase()} (${r.fromName})`} on the website form. Needs: ${REF_NEED[r.need].toLowerCase()}. Home visit because: ${r.eligibility}.${ent ? ` NHS entitlement: ${ent}.` : ""}${r.notes ? ` Notes: ${r.notes}` : ""}`, { name: "Referral form" }, { silent: true });
    const wid = newId("w"), seq = one("SELECT COALESCE(MAX(added_seq), 0) + 1 AS s FROM waitlist").s;
    run("INSERT INTO waitlist (id, patient_id, type, prio, days, avail, short_notice, added_seq, note) VALUES (?, ?, ?, ?, 0, ?, 1, ?, ?)", wid, pid, type, prio, r.avail, seq, "From a referral");
    run("UPDATE referrals SET status = 'accepted', patient_id = ?, decided_by = ? WHERE id = ?", pid, user.name, r.id);
    const to = mobile ? r.phone : r.fromPhone && /^07/.test(r.fromPhone) ? r.fromPhone : null;
    if (to) sendSms({ to, name: mobile ? r.name : r.fromName, kind: "referral", body: `Hi ${first(mobile ? r.name : r.fromName)}, it's ${practice()}. Thank you for the referral for ${mobile ? "you" : r.name}. We've added ${mobile ? "you" : "them"} to our list and will be in touch with a time for the home visit.` });
    audit(user.name, "referral.accepted", r.id, `Patient record ${pid} and waiting list place created`);
    bus.emit({ type: "referral.updated", referralId: r.id });
    bus.emit({ type: "waitlist.added", waitlistId: wid });
    return { patientId: pid, waitlistId: wid, texted: !!to };
  });
}

function declineReferral(id, reason, user) {
  return tx(() => {
    const r = getReferral(id);
    if (r.status !== "new") throw new HttpError(409, `That referral was already ${r.status}.`);
    const why = clean(reason, 200) || "Not eligible for a home visit";
    run("UPDATE referrals SET status = 'declined', decided_by = ?, decline_reason = ? WHERE id = ?", user.name, why, r.id);
    audit(user.name, "referral.declined", r.id, why);
    bus.emit({ type: "referral.updated", referralId: r.id });
    return { ok: true };
  });
}
const referralOptions = () => ({ from: REF_FROM, need: REF_NEED, entitlement: ENTITLEMENT });

/* ---------- Online booking by patients ---------- */
// Glasses deliveries wait for the lab, so the office books those.
/** The kinds of visit a patient could book for themselves. Glasses deliveries are arranged by the practice. */
const ONLINE_TYPES = ["sight", "exam", "repair", "follow"];
const onlineNow = () => ONLINE_TYPES.filter((k) => (settings().online || ONLINE_TYPES).includes(k));
// A self-booked visit may add at most this much driving, so online bookings can't scatter a round.
const ONLINE_MAX_EXTRA = 20;

/** What a patient may choose from: only from tomorrow, and only slots that fit a round efficiently. Never other patients' details. */
function publicSlotList(input) {
  if (!onlineNow().length) throw new HttpError(403, "Online booking is switched off. Please call us to book.");
  const type = onlineNow().includes(input.type) ? input.type : null;
  if (!type) throw new HttpError(400, "Choose what the visit is for.");
  const pc = travel.normalise(input.pc);
  if (!travel.known(pc)) throw new HttpError(400, "We couldn't find that postcode. Please check it, or call us and we'll book for you.");
  const avail = ["am", "pm"].includes(input.avail) ? input.avail : "any";
  const clinicians = Object.fromEntries(all("SELECT id, first FROM clinicians").map((r) => [r.id, r.first]));
  // From tomorrow, up to the online limit (Settings, default 6 weeks). `from` pages on to later dates.
  const max = cal.ahead("onlineAheadDays"), from = searchFrom(input, max, 1);
  return slotsFor({ id: null, pc }, type, avail, { from, count: 10, max }).filter((s) => s.day >= 1 && s.extraDrive <= ONLINE_MAX_EXTRA).slice(0, 4)
    .map((s) => ({ ref: `${s.clinicianId}.${s.day}.${s.start}`, clinicianId: s.clinicianId, day: s.day, start: s.start, dayLabel: cal.label(s.day), time: s.label, clinician: clinicians[s.clinicianId], slot: s }));
}

async function publicFindSlots(input) {
  await warmRoutes({ pc: input.pc });
  const slots = publicSlotList(input).map(({ slot, ...rest }) => rest);
  // The days searched, so the page can offer "later dates": the next window starts the day after.
  const max = cal.ahead("onlineAheadDays"), days = cal.openDays(searchFrom(input, max, 1), 10, max);
  const last = days.length ? days[days.length - 1] : max, next = cal.openDays(last + 1, 1, max)[0];
  return { slots, from: days[0] || null, fromLabel: days.length ? cal.longLabel(days[0]) : null, untilLabel: days.length ? cal.longLabel(last) : null, next: next == null ? null : next };
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
    // Someone booking online is only taken to be an existing patient if both the mobile number and the name match.
    // Otherwise anyone who knew a patient's number could book visits in their name. A mismatch becomes a new record
    // (the office merges it if it's the same person), and the answer looks the same either way, so the form can't
    // be used to find out who is a patient here.
    const sameName = (a, b) => a.toLowerCase().replace(/[^a-z]/g, "") === b.toLowerCase().replace(/[^a-z]/g, "");
    const known = all("SELECT * FROM patients WHERE erased = 0").find((r) => r.phone.replace(/\D/g, "") === digits && sameName(r.name, name));
    const draft = known ? map.patient(known) : { id: null, name, pc: travel.normalise(input.pc), addr, phone: digits.replace(/^(\d{5})(\d{6})$/, "$1 $2"), alerts: [] };
    const r = placeVisit({ draft, c: getClinician(choice.clinicianId), type: input.type, day: choice.day, start: choice.start, slot: choice.slot, actor: "Online booking", by: "the patient online" });
    return { dayLabel: r.dayLabel, time: r.label, clinician: choice.clinician, when: when(r.day, r.start) };
  });
}
const onlineTypes = () => onlineNow().map((k) => ({ key: k, name: TYPES[k].name, dur: TYPES[k].dur, nhs: !!TYPES[k].pvn }));

/* ---------- The office runs everything: records, visits, the team ---------- */
const sameDigits = (a, b) => String(a || "").replace(/\D/g, "") === String(b || "").replace(/\D/g, "");
/** A UK phone number tidied to "07700 900123" / "01204 292005", or null if it isn't one. */
const ukPhone = (v) => { const d = String(v || "").replace(/[\s()-]/g, "").replace(/^\+44/, "0"); return /^0\d{9,10}$/.test(d) ? d.replace(/^(\d{5})(\d+)$/, "$1 $2") : null; };
const upcoming = (pid) => all("SELECT * FROM appointments WHERE patient_id = ? AND status IN ('booked','enroute','live') ORDER BY day, start_min", pid).map(map.appt);

/** Re-work the drive to each visit in a round from the stop before it (the first from home) after the round changes. */
function redrive(cid, day) {
  const c = getClinician(cid); if (!c) return;
  let prev = c.base;
  all("SELECT a.id, a.status, a.drive, p.pc FROM appointments a JOIN patients p ON p.id = a.patient_id WHERE a.clinician_id = ? AND a.day = ? AND a.status != 'cancelled' ORDER BY a.start_min", cid, day).forEach((r, i) => {
    const d = i === 0 ? 0 : travel.driveMinutes(prev, r.pc) || 10;
    if (r.status === "booked" && d !== r.drive) run("UPDATE appointments SET drive = ? WHERE id = ?", d, r.id);
    prev = r.pc;
  });
}

const PATIENT_LABELS = { name: "name", addr: "address", pc: "postcode", phone: "phone", contact: "how to contact", email: "email", dob: "date of birth",
  eligibility: "reason for a home visit", rep: "next of kin or carer", poa: "power of attorney", share: "consent to talk to family", specs: "glasses", alerts: "visit notes", lastTest: "last sight test", recallMonths: "recall", obId: "Opticabase ID", nextExam: "next exam", nhsNo: "NHS number", premises: "where they're seen", venue: "care home or day centre", venueContact: "contact at the premises" };

/** The checks on a patient's details, shared by adding and editing. Only the fields sent are checked and returned. */
function patientFields(input, before) {
  const has = (k) => Object.prototype.hasOwnProperty.call(input, k);
  const next = {};
  if (has("name")) { const v = clean(input.name, 80); if (v.length < 2) throw new HttpError(400, "Enter the patient's full name."); next.name = v; }
  if (has("addr")) { const v = clean(input.addr, 120); if (v.length < 4) throw new HttpError(400, "Enter the first line of the address."); next.addr = v; }
  if (has("pc")) {
    const v = travel.normalise(input.pc);
    if (!travel.known(v)) throw new HttpError(400, "Choose the town and postcode area, or type the full postcode.");
    next.pc = v;
  }
  if (has("phone")) { const v = ukPhone(input.phone); if (!v) throw new HttpError(400, "Enter a UK phone number, like 07700 900123 or 01204 292005."); next.phone = v; }
  if (has("contact")) { if (!["Text", "Call"].includes(input.contact)) throw new HttpError(400, "Choose text or call."); next.contact = input.contact; }
  const phone = next.phone || before.phone, contact = next.contact || before.contact;
  if (contact === "Text" && !/^07/.test(phone)) throw new HttpError(400, "Texts need a mobile number. Add one, or set them to be phoned.");
  if (has("email")) { const v = clean(input.email, 120); if (v && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) throw new HttpError(400, "That email address doesn't look right."); next.email = v || null; }
  if (has("dob")) {
    const v = String(input.dob || "");
    if (v && !(/^\d{4}-\d{2}-\d{2}$/.test(v) && v >= "1900-01-01" && v <= "2026-10-12")) throw new HttpError(400, "Enter the date of birth as a date in the past.");
    next.dob = v || null;
  }
  if (has("eligibility")) {
    const v = clean(input.eligibility, 200);
    // Checked only when it changes, so an old "Housebound" doesn't block saving a new phone number.
    if (v && v !== before.eligibility && GENERIC_REASON.test(v)) throw new HttpError(400, `Record the illness or condition behind "${v}". The NHS claim needs it.`);
    next.eligibility = v || null;
  }
  if (has("rep")) next.rep = clean(input.rep, 120) || null;
  if (has("poa")) next.poa = clean(input.poa, 120) || null;
  if (has("share")) { if (!["yes", "no", "", null].includes(input.share)) throw new HttpError(400, "Choose whether we may talk to their next of kin or carer."); next.share = input.share || null; }
  if (has("lastTest")) {
    const v = String(input.lastTest || "");
    if (v && !(/^\d{4}-\d{2}-\d{2}$/.test(v) && v >= "1990-01-01" && v <= cal.iso(0))) throw new HttpError(400, "Enter the last sight test as a date, not in the future.");
    next.lastTest = v || null;
  }
  if (has("obId")) {
    const v = String(input.obId || "").trim().replace(/\s+/g, "");
    if (v && !/^[A-Za-z0-9/-]{1,20}$/.test(v)) throw new HttpError(400, "An Opticabase ID is letters and numbers, up to 20.");
    if (v && one("SELECT 1 FROM patients WHERE ob_id = ? AND id IS NOT ?", v, before.id || null)) throw new HttpError(409, `Another patient already has Opticabase ID ${v}.`);
    next.obId = v || null;
  }
  if (has("nhsNo")) {
    const v = String(input.nhsNo || "").replace(/\D/g, "");
    if (v && !validNhsNumber(v)) throw new HttpError(400, "That isn't a valid NHS number: it's 10 digits, and the last one is a check digit.");
    if (v && one("SELECT 1 FROM patients WHERE nhs_no = ? AND id IS NOT ?", v, before.id || null)) throw new HttpError(409, "Another patient already has that NHS number.");
    next.nhsNo = v || null;
  }
  if (has("premises")) {
    const v = input.premises || "home";
    if (!pvn.PREMISES[v]) throw new HttpError(400, "Choose where they're seen: home, residential home, nursing home, day centre or sheltered housing.");
    next.premises = v;
  }
  if (has("venue")) next.venue = clean(input.venue, 80) || null;
  if (has("venueContact")) next.venueContact = clean(input.venueContact, 80) || null;
  if (has("nextExam")) {
    const v = String(input.nextExam || "");
    if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new HttpError(400, "Enter the next exam as a date.");
    next.nextExam = v || null;
  }
  if (has("recallMonths")) {
    const v = input.recallMonths == null || input.recallMonths === "" ? null : Number(input.recallMonths);
    if (v != null && ![3, 6, 12, 24].includes(v)) throw new HttpError(400, "Choose a recall of 3, 6, 12 or 24 months.");
    next.recallMonths = v === 12 ? null : v; // 12 is the default, stored as none
  }
  if (has("specs")) next.specs = clean(input.specs, 80) || "None on record";
  if (has("alerts")) {
    const list = (Array.isArray(input.alerts) ? input.alerts : String(input.alerts || "").split("\n")).map((a) => clean(a, 120)).filter(Boolean).slice(0, 8);
    next.alerts = list;
  }
  return next;
}

/**
 * The office adds a patient by hand: someone who phoned in, or a referral that came by post. Name, address,
 * postcode and phone are needed to visit them; everything else can follow. Someone already on Domi with the
 * same name and phone or date of birth is refused, with a pointer to their record, so nobody is entered twice.
 */
async function createPatient(input, user) {
  for (const k of ["name", "addr", "pc", "phone"]) if (!String(input[k] || "").trim()) throw new HttpError(400, `Enter the patient's ${PATIENT_LABELS[k]}.`);
  const p = { contact: "Text", ...patientFields({ contact: "Text", ...input }, { contact: "Text", phone: "" }) };
  const twin = all("SELECT id, name, phone, dob FROM patients WHERE erased = 0").find((r) => r.name.toLowerCase() === p.name.toLowerCase() && ((p.dob && r.dob === p.dob) || sameDigits(r.phone, p.phone)));
  if (twin) throw Object.assign(new HttpError(409, `${twin.name} is already on Domi with the same ${p.dob && twin.dob === p.dob ? "date of birth" : "phone number"}.`), { extra: { patientId: twin.id } });
  await travel.prepare([p.pc]);
  return tx(() => {
    const id = newId("p");
    const age = p.dob ? Math.floor((cal.todayMs() - Date.parse(p.dob)) / (365.25 * 864e5)) : null;
    run("INSERT INTO patients (id, name, age, addr, pc, phone, contact, alerts, specs, dob, email, eligibility, rep, poa, share, nhs_no, premises, venue, venue_contact) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      id, p.name, age, p.addr, p.pc, p.phone, p.contact, JSON.stringify(p.alerts || []), p.specs || "None on record", p.dob || null, p.email || null, p.eligibility || null, p.rep || null, p.poa || null, p.share || null, p.nhsNo || null, p.premises || null, p.venue || null, p.venueContact || null);
    const lead = input.leadId ? one("SELECT id FROM leads WHERE id = ? AND patient_id IS NULL", String(input.leadId)) : null;
    if (lead) run("UPDATE leads SET patient_id = ? WHERE id = ?", id, lead.id); // the lead now points to their record
    addNote(id, lead ? "Added by the office from a Facebook lead." : "Added by the office.", user, { silent: true });
    audit(user.name, "patient.create", id, lead ? "Added from a lead" : "Added by hand"); // no personal details in the audit line
    bus.emit({ type: "patient.updated", patientId: id });
    return { patient: getPatient(id) };
  });
}

/**
 * The office changes a patient's details. Only the fields sent are changed. The audit log records which fields
 * changed, never the old or new values; the clinician is told if the address of an upcoming visit changed.
 */
async function updatePatient(id, input, user) {
  const before = getPatient(String(id));
  if (!before) throw new HttpError(404, "Patient not found.");
  if (before.erased) throw new HttpError(409, "This patient's details were erased.");
  const next = patientFields(input, before);
  const changed = Object.keys(next).filter((k) => JSON.stringify(next[k]) !== JSON.stringify(before[k]));
  if (!changed.length) return { patient: before, changed: [] };
  if (next.pc) await travel.prepare([next.pc, ...upcoming(before.id).map((a) => getClinician(a.clinicianId).base)]);
  return tx(() => {
    const cols = { name: "name", addr: "addr", pc: "pc", phone: "phone", contact: "contact", email: "email", dob: "dob", eligibility: "eligibility", rep: "rep", poa: "poa", share: "share", specs: "specs", alerts: "alerts", lastTest: "last_test", recallMonths: "recall_months", obId: "ob_id", nextExam: "next_exam", nhsNo: "nhs_no", premises: "premises", venue: "venue", venueContact: "venue_contact" };
    for (const k of changed) run(`UPDATE patients SET ${cols[k]} = ? WHERE id = ?`, k === "alerts" ? JSON.stringify(next[k]) : next[k], before.id);
    if (changed.includes("dob")) run("UPDATE patients SET age = ? WHERE id = ?", next.dob ? Math.floor((cal.todayMs() - Date.parse(next.dob)) / (365.25 * 864e5)) : before.age, before.id);
    const labels = changed.map((k) => PATIENT_LABELS[k]);
    const moved = changed.includes("addr") || changed.includes("pc");
    if (moved) {
      // Their visits are now somewhere else: drive times change, and each clinician needs the new address.
      const rounds = new Set();
      for (const a of upcoming(before.id)) {
        rounds.add(a.clinicianId + ":" + a.day);
        const c = getClinician(a.clinicianId), p = getPatient(before.id);
        sendSms({ to: "clinician", name: c.name, kind: "diary-change", toClinicianId: c.id, body: `Address change for ${p.name} (${cal.label(a.day)} ${hm(a.start)}): now ${p.addr}, ${p.pc}.` });
      }
      for (const r of rounds) { const [cid, day] = r.split(":"); redrive(cid, Number(day)); }
    }
    addNote(before.id, `Details updated by the office: ${labels.join(", ")}.`, user, { silent: true });
    audit(user.name, "patient.update", before.id, `Changed ${labels.join(", ")}`);
    bus.emit({ type: "patient.updated", patientId: before.id });
    return { patient: getPatient(before.id), changed: labels };
  });
}

/* ---------- Settings: the practice's own details and rules, which the rest of Domi reads ---------- */
const SETTING_LABELS = { practice: "practice name", phone: "phone number", email: "email", logo: "logo", officeHours: "office hours", dayStart: "opening time", dayEnd: "closing time",
  prices: "prices", durations: "visit lengths", clinicTarget: "patients-per-day target", online: "online booking", mode: "how cancellations are filled", offerMinutes: "reply window", autoRecalls: "automatic recall texts", recallAt: "recall text time", reminders: "reminders", reminderAt: "reminder time", fee: "fee per visit",
  bookAheadDays: "how far ahead the office can book", onlineAheadDays: "how far ahead patients can book online", offerAheadDays: "how far ahead gaps are offered", closures: "closure days" };
const plain = (v, max) => String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

/**
 * The office changes the practice's settings. Only the fields sent are checked and changed, and a value that
 * doesn't make sense is refused with a reason rather than quietly ignored. Opening hours can't shrink past a
 * clinician's working hours: the office is told whose hours to change first, so no booked visit is stranded.
 */
function saveSettings(input, user) {
  const st = settings(), has = (k) => Object.prototype.hasOwnProperty.call(input, k), next = {};
  if (has("practice")) { const v = plain(input.practice, 60); if (v.length < 2) throw new HttpError(400, "Enter the practice's name."); next.practice = v; }
  if (has("phone")) {
    const v = plain(input.phone, 24);
    if (v && !ukPhone(v)) throw new HttpError(400, "Enter a UK phone number, like 01204 292005.");
    next.phone = v ? (st.phone && ukPhone(st.phone) === ukPhone(v) ? st.phone : ukPhone(v)) : null; // keep their own spacing if the number is the same
  }
  if (has("email")) { const v = plain(input.email, 120).toLowerCase(); if (v && !/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(v)) throw new HttpError(400, "That email address doesn't look right."); next.email = v || null; }
  if (has("logo")) {
    const v = plain(input.logo, 300);
    let url = null;
    if (v) { try { url = new URL(v); } catch { url = null; } if (!url || url.protocol !== "https:") throw new HttpError(400, "The logo's address must start with https://, like the logo on your own website."); }
    next.logo = url ? url.href : null;
  }
  if (has("officeHours")) { const v = plain(input.officeHours, 120).replace(/\.$/, ""); if (v.length < 3) throw new HttpError(400, "Enter the office hours, like Monday to Friday, 9am to 5.30pm."); next.officeHours = v; }
  if (has("dayStart") || has("dayEnd")) {
    const s = Number(has("dayStart") ? input.dayStart : st.dayStart), e = Number(has("dayEnd") ? input.dayEnd : st.dayEnd);
    if (!(s % 15 === 0 && e % 15 === 0 && s >= 7 * 60 && e <= 20 * 60 && e - s >= 4 * 60)) throw new HttpError(400, "Opening hours must be between 07:00 and 20:00, at least four hours, in quarter hours.");
    const outside = all("SELECT * FROM clinicians WHERE active = 1 ORDER BY id").map(map.clinician)
      .map((c) => ({ c, d: (c.hours || []).findIndex((h) => h && (h[0] < s || h[1] > e)) })).filter((x) => x.d >= 0);
    if (outside.length) {
      const { c, d } = outside[0], h = c.hours[d];
      const others = outside.length - 1;
      throw new HttpError(409, `${c.name} works ${hm(h[0])}–${hm(h[1])} on ${cal.WEEKDAYS[d]}s, outside ${hm(s)}–${hm(e)}${others ? ` (as ${others === 1 ? "does 1 other clinician" : `do ${others} other clinicians`})` : ""}. Change their hours on the Team page first.`);
    }
    next.dayStart = s; next.dayEnd = e;
  }
  if (has("prices")) {
    if (!input.prices || typeof input.prices !== "object") throw new HttpError(400, "Prices must be a list of visit types.");
    const prices = { ...st.prices };
    for (const [k, v] of Object.entries(input.prices)) {
      if (!(k in TYPES)) throw new HttpError(400, "That isn't one of the practice's visit types.");
      const n = Number(v);
      if (!(Number.isFinite(n) && n >= 0 && n <= 5000)) throw new HttpError(400, `The price for ${lowerName(TYPES[k].name)} must be between £0 and £5,000.`);
      prices[k] = Math.round(n);
    }
    next.prices = prices;
  }
  if (has("clinicTarget")) {
    const n = Number(input.clinicTarget);
    if (!(Number.isInteger(n) && n >= 1 && n <= 30)) throw new HttpError(400, "The target is patients seen per clinician per day: 1 to 30.");
    next.clinicTarget = n;
  }
  if (has("durations")) {
    if (!input.durations || typeof input.durations !== "object") throw new HttpError(400, "Visit lengths must be a list of visit types.");
    const durations = { ...(st.durations || {}) };
    for (const [k, v] of Object.entries(input.durations)) {
      if (!(k in TYPES)) throw new HttpError(400, "That isn't one of the practice's visit types.");
      const n = Number(v);
      if (!(Number.isInteger(n) && n >= 10 && n <= 180 && n % 5 === 0)) throw new HttpError(400, `${TYPES[k].name}: a visit must be 10 minutes to 3 hours, in 5-minute steps.`);
      durations[k] = n;
    }
    // Longer visits mustn't run into the next booked visit, or past the clinician's day.
    const lenOf = (t) => durations[t] || DEFAULT_DUR[t];
    const booked = all("SELECT a.*, p.name FROM appointments a JOIN patients p ON p.id = a.patient_id WHERE a.status IN ('booked','enroute') AND a.day >= 0 ORDER BY a.clinician_id, a.day, a.start_min");
    const clash = [];
    booked.forEach((a, i) => {
      const n = booked[i + 1], end = a.start_min + lenOf(a.type);
      const c = getClinician(a.clinician_id), h = c && cal.isOpen(a.day) ? (c.hours || [])[cal.weekday(a.day)] : null;
      if ((n && n.clinician_id === a.clinician_id && n.day === a.day && end > n.start_min) || (h && end > h[1])) clash.push(a);
    });
    if (clash.length) { const x = clash[0]; throw new HttpError(409, `With those lengths, ${clash.length} booked visit${clash.length === 1 ? " runs" : "s run"} into the next one or past the end of the day (${x.name}, ${cal.label(x.day)} ${hm(x.start_min)}${clash.length > 1 ? ", and more" : ""}). Move ${clash.length === 1 ? "it" : "them"} first, or choose shorter lengths.`); }
    next.durations = durations;
  }
  if (has("online")) {
    const list = Array.isArray(input.online) ? [...new Set(input.online.map(String))] : null;
    if (!list || list.some((k) => !ONLINE_TYPES.includes(k))) throw new HttpError(400, "Choose which visits patients can book online.");
    // An empty list switches online booking off: the booking page then asks patients to phone.
    next.online = ONLINE_TYPES.filter((k) => list.includes(k));
  }
  if (has("mode")) { if (!["offer", "instant", "phone"].includes(input.mode)) throw new HttpError(400, "Choose how cancelled visits are filled."); next.mode = input.mode; }
  if (has("offerMinutes")) { const n = Number(input.offerMinutes); if (!(Number.isInteger(n) && n >= 1 && n <= 240)) throw new HttpError(400, "The reply window must be between 1 and 240 minutes."); next.offerMinutes = n; }
  if (has("autoRecalls")) { if (typeof input.autoRecalls !== "boolean") throw new HttpError(400, "Turn automatic recall texts on or off."); next.autoRecalls = input.autoRecalls; }
  // How far ahead bookings can go, in days: the office (up to 2 years), patients online, and gaps offered by text.
  const span = (k, min, maxd, what) => { if (!has(k)) return; const n = Number(input[k]); if (!(Number.isInteger(n) && n >= min && n <= maxd)) throw new HttpError(400, `${what} must be between ${min} and ${maxd} days.`); next[k] = n; };
  span("bookAheadDays", 28, 730, "How far ahead the office can book");
  span("onlineAheadDays", 7, 180, "How far ahead patients can book online");
  span("offerAheadDays", 1, 60, "How far ahead cancelled visits are offered");
  if ((next.onlineAheadDays || st.onlineAheadDays) > (next.bookAheadDays || st.bookAheadDays)) throw new HttpError(400, "Patients can't book further ahead than the office.");
  if (has("closures")) {
    // Days the practice is shut besides weekends and bank holidays: training, the Christmas week. [{date, reason}]
    if (!Array.isArray(input.closures) || input.closures.length > 60) throw new HttpError(400, "Closure days must be a list of up to 60 dates.");
    const seen = new Set();
    next.closures = input.closures.map((c) => {
      const date = String((c && c.date) || c || "").slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) throw new HttpError(400, "Enter closure dates like 2026-12-24.");
      if (seen.has(date)) throw new HttpError(400, `${date} is in the list twice.`);
      seen.add(date);
      return { date, reason: plain((c && c.reason) || "Practice closed", 60) || "Practice closed" };
    }).sort((a, b) => a.date.localeCompare(b.date));
    const hit = next.closures.map((c) => ({ c, d: cal.dayOf(c.date) })).filter((x) => x.d >= 0).map((x) => ({ ...x, n: one("SELECT COUNT(*) AS n FROM appointments WHERE day = ? AND status IN ('booked','enroute')", x.d).n })).find((x) => x.n);
    if (hit) throw new HttpError(409, `${hit.n} visit${hit.n === 1 ? " is" : "s are"} booked on ${cal.label(hit.d)}. Move ${hit.n === 1 ? "it" : "them"} before closing that day.`);
  }
  if (has("recallAt")) { const n = Number(input.recallAt); if (!(n % 15 === 0 && n >= 8 * 60 && n <= 18 * 60)) throw new HttpError(400, "Recall texts go out between 08:00 and 18:00, on the quarter hour."); next.recallAt = n; }
  if (has("reminders")) { if (typeof input.reminders !== "boolean") throw new HttpError(400, "Turn reminders on or off."); next.reminders = input.reminders; }
  if (has("reminderAt")) { const n = Number(input.reminderAt); if (!(n % 15 === 0 && n >= 8 * 60 && n <= 21 * 60)) throw new HttpError(400, "Reminders go out between 08:00 and 21:00, on the quarter hour."); next.reminderAt = n; }
  if (has("fee")) { const n = Number(input.fee); if (!(Number.isFinite(n) && n >= 0 && n <= 2000)) throw new HttpError(400, "The fee per visit must be between £0 and £2,000."); next.fee = Math.round(n); }
  const changed = Object.keys(next).filter((k) => JSON.stringify(next[k]) !== JSON.stringify(st[k]));
  if (!changed.length) return { settings: st, changed: [] };
  Object.assign(st, next);
  const labels = changed.map((k) => SETTING_LABELS[k]);
  audit(user.name, "settings.update", "settings", `Changed ${labels.join(", ")}`);
  bus.emit({ type: "settings.updated", settings: st });
  return { settings: st, changed: labels };
}

/** What patients receive, worded from today's settings, for the office to check before anything is sent. */
function messagePreviews() {
  const st = settings(), c = all("SELECT * FROM clinicians WHERE active = 1 ORDER BY id").map(map.clinician)[0] || { first: "Sam" };
  const at = Math.min(st.dayStart + 90, st.dayEnd - 60);
  const visit = `${when(1, at)} with ${c.first} (${lowerName(TYPES.sight.name)})`;
  return [
    { key: "reminder", title: "Day-before reminder", channel: "Text", when: st.reminders ? `Sent at ${hm(st.reminderAt)} the day before each visit` : "Off: no reminders are sent", body: reminderText("Joan Whittle", c.first, 1, at, "sight", "https://…/c/ab12") },
    { key: "offer", title: "Cancelled visit offered", channel: "Text", when: `To the best-matched patients on the waiting list, who have ${st.offerMinutes} minutes to reply`, body: offerText("Joan Whittle", visit, hm(sandbox.nowMin() + st.offerMinutes), false) },
    { key: "recall", title: "Recall", channel: "Text", when: st.autoRecalls ? `Sent automatically at ${hm(st.recallAt)} to patients due within a fortnight who take texts` : "Sent when the office presses Text link", body: recallText("Joan Whittle", "NHS sight test due (2 years)", `${sandbox.current().base || "https://…"}/book/${sandbox.current().id}`) },
    { key: "offer-close", title: "Offer when the visit is close", channel: "Text", when: "When there isn't time to ask one person at a time, the first YES gets it", body: offerText("Joan Whittle", visit, hm(sandbox.nowMin() + 10), true) },
  ];
}

/**
 * Everything Domi holds about one patient, for a subject access request under UK GDPR (or to send to another
 * practice). Audited.
 */
function exportPatient(id, user) {
  const p = getPatient(String(id));
  if (!p) throw new HttpError(404, "Patient not found.");
  return tx(() => {
    const visits = all("SELECT a.*, c.name AS clinician FROM appointments a JOIN clinicians c ON c.id = a.clinician_id WHERE a.patient_id = ? ORDER BY a.day, a.start_min", p.id)
      .map((r) => ({ day: cal.label(r.day), time: hm(r.start_min), type: TYPES[r.type].name, clinician: r.clinician, status: r.status, reason: r.reason || undefined }));
    const texts = all("SELECT * FROM messages WHERE phone IS NOT NULL ORDER BY id").filter((m) => p.phone && sameDigits(m.phone, p.phone))
      .map((m) => ({ at: m.created_at, direction: m.direction === "in" ? "from the patient" : "to the patient", body: m.body }));
    const out = {
      exported: { at: `${cal.label(0)} ${sandbox.stamp()}`, by: user.name, practice: practice(), note: "Everything this practice holds about the patient in Domi." },
      patient: { name: p.name, dateOfBirth: p.dob, age: p.age, address: p.addr, postcode: p.pc, phone: p.phone, contact: p.contact, email: p.email,
        reasonForHomeVisit: p.eligibility, nextOfKin: p.rep, powerOfAttorney: p.poa, mayTalkToFamily: p.share, glasses: p.specs, lastSightTest: p.lastTest, prescription: p.rx, visitNotes: p.alerts },
      notes: all("SELECT * FROM notes WHERE patient_id = ? ORDER BY id", p.id).map((n) => ({ when: n.label, by: n.author || undefined, note: n.body })),
      visits,
      waitingList: all("SELECT * FROM waitlist WHERE patient_id = ?", p.id).map((w) => ({ for: TYPES[w.type].name, priority: w.prio, status: w.status, note: w.note || undefined })),
      recalls: all("SELECT * FROM recalls WHERE patient_id = ?", p.id).map((r) => ({ reason: r.reason, status: r.status })),
      invoices: all("SELECT * FROM invoices WHERE patient_id = ?", p.id).map((i) => ({ number: i.number, total: `£${(i.total_pence / 100).toFixed(2)}`, status: i.status, issued: i.issued_at })),
      referrals: all("SELECT * FROM referrals WHERE patient_id = ?", p.id).map((r) => ({ received: r.created_at, from: REF_FROM[r.from_kind], referrer: r.from_name || undefined, reason: r.eligibility, notes: r.notes || undefined })),
      texts,
    };
    audit(user.name, "patient.export", p.id, "Exported everything held about them");
    return out;
  });
}

/**
 * Erase a patient's personal details on request (UK GDPR right to erasure). Refused while visits are booked, and
 * for anyone already seen: clinical and NHS claim records must be kept (for at least 7 years in England), so the
 * right to erasure doesn't apply to them. What's left is an anonymous row, so diaries and counts still add up.
 */
function erasePatient(id, input, user) {
  return tx(() => {
    const p = getPatient(String(id));
    if (!p) throw new HttpError(404, "Patient not found.");
    if (p.erased) throw new HttpError(409, "Their details have already been erased.");
    if (clean(input.confirm, 80).toLowerCase() !== p.name.toLowerCase()) throw new HttpError(400, `Type ${p.name}'s full name to confirm.`);
    const booked = upcoming(p.id);
    if (booked.length) throw new HttpError(409, `${p.name} has ${booked.length} visit${booked.length === 1 ? "" : "s"} booked. Cancel ${booked.length === 1 ? "it" : "them"} first.`);
    if (one("SELECT 1 FROM appointments WHERE patient_id = ? AND status IN ('done','missed')", p.id) || one("SELECT 1 FROM invoices WHERE patient_id = ?", p.id))
      throw new HttpError(409, `${p.name} has been seen, so their clinical and NHS claim records must be kept (at least 7 years). Their details can't be erased yet.`);
    if (one("SELECT 1 FROM waitlist WHERE patient_id = ? AND status = 'offered'", p.id)) throw new HttpError(409, `${p.name} has just been offered a visit. Wait for their reply.`);
    const name = p.name;
    run("DELETE FROM offers WHERE waitlist_id IN (SELECT id FROM waitlist WHERE patient_id = ?)", p.id);
    run("DELETE FROM recalls WHERE patient_id = ?", p.id);
    run("DELETE FROM waitlist WHERE patient_id = ?", p.id);
    run("DELETE FROM notes WHERE patient_id = ?", p.id);
    for (const m of all("SELECT id, phone FROM messages WHERE phone IS NOT NULL")) if (p.phone && sameDigits(m.phone, p.phone)) run("DELETE FROM messages WHERE id = ?", m.id);
    // Their name also appears in texts to clinicians and in the activity log: replace it there too.
    run("UPDATE messages SET body = replace(body, ?, 'an erased patient'), to_name = replace(to_name, ?, 'Erased patient')", name, name);
    run("UPDATE audit SET detail = replace(detail, ?, 'an erased patient')", name);
    run("UPDATE appointments SET note = NULL WHERE patient_id = ?", p.id);
    run("UPDATE referrals SET name = 'Erased patient', dob = NULL, addr = 'Erased', phone = NULL, eligibility = 'Erased', notes = NULL, from_name = NULL, from_phone = NULL, entitlement = '[]' WHERE patient_id = ?", p.id);
    run(`UPDATE patients SET name = 'Erased patient', age = NULL, addr = 'Erased', pc = ?, phone = '', contact = 'Call', alerts = '[]', specs = '', rx = NULL,
      dob = NULL, email = NULL, eligibility = NULL, rep = NULL, last_test = NULL, erased = 1 WHERE id = ?`, district(p.pc), p.id);
    audit(user.name, "patient.erase", p.id, "Personal details erased on request");
    bus.emit({ type: "patient.updated", patientId: p.id });
    return { ok: true };
  });
}

/* Moving a visit to another time, in one step: one text, the PCSE notification moved with it. */
function movable(id) {
  const a = getAppt(String(id));
  if (!a) throw new HttpError(404, "That visit no longer exists.");
  if (a.status !== "booked") throw new HttpError(409, "Only visits that haven't started can be moved.");
  return a;
}
/**
 * Record when a patient can be seen for a visit (domain TW), and with `always`, for every visit from now on. Visits
 * already booked outside it are flagged, not moved: the office re-plans the route or moves the visit.
 */
function setAvailability(id, input, user) {
  return tx(() => {
    const a = getAppt(String(id));
    if (!a) throw new HttpError(404, "That visit no longer exists.");
    let tw;
    try { tw = twParse(input.tw, input.at); } catch (e) { throw new HttpError(400, e.message); }
    const p = getPatient(a.patientId);
    run("UPDATE appointments SET tw = ?, tw_at = ? WHERE id = ?", tw ? tw.k : null, tw ? tw.at : null, a.id);
    if (input.always === true) {
      run("UPDATE patients SET tw = ?, tw_at = ? WHERE id = ?", tw ? tw.k : null, tw ? tw.at : null, p.id);
      // Their other visits not yet started follow the standing arrangement too.
      run("UPDATE appointments SET tw = ?, tw_at = ? WHERE patient_id = ? AND status = 'booked' AND id != ?", tw ? tw.k : null, tw ? tw.at : null, p.id, a.id);
    }
    const label = tw ? twLabel(tw) : "Any time";
    addNote(p.id, `Can be seen: ${label}${input.always === true ? " (from now on)" : ` (for ${cal.label(a.day)})`}.`, user, { silent: true });
    audit(user.name, "appointment.availability", a.id, `${p.name}: ${label}${input.always === true ? ", always" : ""}`);
    const clash = all("SELECT * FROM appointments WHERE patient_id = ? AND status = 'booked'", p.id).map(map.appt).filter((x) => !twAllows(x.tw, x.start));
    bus.emit({ type: "appointment.updated", clinicianId: a.clinicianId, appointmentId: a.id });
    return { ok: true, label, outside: clash.map((x) => ({ id: x.id, day: x.day, dayLabel: cal.label(x.day), start: x.start, clinicianId: x.clinicianId })) };
  });
}

/** Where this visit could go instead: the same search as booking, with its current time counted as free. */
async function moveOptions(id, input) {
  const a = movable(id), p = getPatient(a.patientId);
  await warmRoutes({ patientId: p.id });
  const from = searchFrom(input);
  const slots = slotsFor(p, a.type, input.avail, { exclude: a.id, from, pvnApproved: !!icbOf(input), tw: a.tw })
    .filter((s) => !(s.clinicianId === a.clinicianId && s.day === a.day && s.start === a.start)).slice(0, 6);
  return { appointmentId: a.id, patient: { id: p.id, name: p.name, pc: p.pc }, type: a.type, from: { clinicianId: a.clinicianId, day: a.day, start: a.start }, searchFrom: from, fromLabel: cal.label(from), slots };
}
async function moveAppointment(id, input, user) {
  const pre = movable(id);
  await warmRoutes({ patientId: pre.patientId });
  return tx(() => {
    const a = movable(id), p = getPatient(a.patientId), t = TYPES[a.type];
    const c = getClinician(String(input.clinicianId || ""));
    if (!c) throw new HttpError(400, "Choose a clinician.");
    const day = bookableDay(Number(input.day)), start = Number(input.start);
    checkNhsLine(p, a.type, day, input.early === true);
    if (input.early === true) p.early = true;
    // PCSE needs 48 working hours' notice of a change, before both the old date and the new one.
    const icb = icbOf(input), moving = a.day !== day || a.start_min !== start;
    let problem = moving ? checkPvn(p, a.type, day, start, icb, a.id) : null;
    if (moving && t.pvn && cal.workMinutesUntil(a.day, a.start_min, sandbox.nowMin()) < PVN_NOTICE_MIN && one("SELECT 1 FROM pcse WHERE appointment_id = ? AND action = 'lodge' AND status = 'done'", a.id)) {
      if (!icb) throw new HttpError(409, `PCSE needs 48 hours' notice of a change to a notified NHS visit, before the old date too, and ${cal.label(a.day)} ${hm(a.start_min)} is too soon. Record the ICB's approval to move it.`);
      problem = problem || { rule: "48 hours" };
    }
    if (!twAllows(a.tw, start)) throw new HttpError(409, `${p.name} can only be seen "${twLabel(a.tw)}". Change their availability on the visit first if that's changed.`);
    const slot = slotsFor(p, a.type, input.avail, { exclude: a.id, from: day, count: 1, pvnApproved: !!icb, tw: a.tw }).find((s) => s.clinicianId === c.id && s.day === day && s.start === start);
    if (!slot) throw new HttpError(409, "That time has just gone, or doesn't fit. Search again for the latest options.");
    const old = getClinician(a.clinicianId);
    run("UPDATE appointments SET clinician_id = ?, day = ?, start_min = ?, drive = ?, reminded = 0, seen = 0 WHERE id = ?", c.id, day, start, slot.driveIn, a.id);
    if (moving && t.pvn) run("UPDATE appointments SET pvn_icb = ? WHERE id = ?", problem ? icb : null, a.id);
    if (problem) audit(user.name, "pcse.short-notice", a.id, `${p.name} moved inside PCSE's ${problem.rule} notice, approved by ${icb} (ICB)`);
    if (a.day !== day || a.start_min !== start) run("DELETE FROM confirmations WHERE appointment_id = ?", a.id); // a new time means calling again
    redrive(old.id, a.day); redrive(c.id, day);
    // PCSE's notification is for a date and time: cancel the old one and lodge the new.
    pcseTask("cancel", a, p); pcseTask("lodge", getAppt(a.id), p);
    if (moving || old.id !== c.id) diaryLog("moved", getAppt(a.id), { was: { day: a.day, start: a.start, clinician: old.name } });
    const was = `${cal.label(a.day)} ${hm(a.start)}`;
    textPatient(p, { kind: "time-change", body: `Hi ${first(p.name)}, it's ${practice()}. Your home visit has moved to ${when(day, start)} with ${c.first} (was ${cal.phrase(a.day).replace(/^on /, "")} at ${hm(a.start)}). Reply CANCEL if that doesn't suit.` });
    sendSms({ to: "clinician", name: old.name, kind: "diary-change", toClinicianId: old.id, body: old.id === c.id
      ? `Diary change: ${p.name} (${lowerName(t.name)}) has moved from ${was} to ${cal.label(day)} ${hm(start)}.`
      : `Diary change: ${p.name} (${was}) has moved to ${c.first}'s round. That time is free now.` });
    if (old.id !== c.id) sendSms({ to: "clinician", name: c.name, kind: "diary-change", toClinicianId: c.id, body: `New visit: ${p.name}, ${lowerName(t.name)}, ${cal.label(day)} ${hm(start)} at ${p.addr} ${p.pc}. Moved from ${old.first}'s round.` });
    addNote(p.id, `Visit moved by the office from ${was} (${old.name}) to ${cal.label(day)} ${hm(start)} (${c.name}).`, user, { silent: true });
    audit(user.name, "appointment.move", a.id, `${p.name}: ${was} ${old.name} → ${cal.label(day)} ${hm(start)} ${c.name}`);
    bus.emit({ type: "appointment.moved", clinicianId: old.id, appointmentId: a.id });
    if (old.id !== c.id) bus.emit({ type: "appointment.moved", clinicianId: c.id, appointmentId: a.id });
    return { appointmentId: a.id, patient: p.name, clinician: c.name, clinicianId: c.id, day, start, dayLabel: cal.label(day), label: slot.label, texted: p.contact !== "Call" };
  });
}

/**
 * The office records what happened at a visit, for a clinician who couldn't (no signal, flat phone, forgot).
 * "done" completes it without any "on the way" text and raises the invoice; "missed" means nobody was in.
 */
function recordOutcome(id, input, user) {
  return tx(() => {
    const a = getAppt(String(id));
    if (!a) throw new HttpError(404, "That visit no longer exists.");
    if (!["booked", "enroute", "live"].includes(a.status)) throw new HttpError(409, `That visit is already ${a.status === "done" ? "complete" : a.status}.`);
    if (a.day > 0 || a.start > sandbox.nowMin()) throw new HttpError(409, "That visit hasn't started yet. Record it once its time has passed.");
    const outcome = input.outcome === "missed" ? "missed" : input.outcome === "done" ? "done" : null;
    if (!outcome) throw new HttpError(400, "Choose what happened.");
    const p = getPatient(a.patientId), c = getClinician(a.clinicianId), note = clean(input.note, 2000);
    run("UPDATE appointments SET status = ?, seen = 1 WHERE id = ?", outcome, a.id);
    let invoice = null, rebooked = null;
    if (outcome === "done") {
      invoice = raiseInvoice(getAppt(a.id), user);
      addNote(p.id, note ? `Recorded by the office for ${c.name}: ${note}` : `Visit completed with ${c.name} (recorded by the office).`, user, { silent: true });
    } else {
      pcseTask("cancel", a, p); // no sight test happened, so no claim: PCSE's notification is withdrawn
      addNote(p.id, `Nobody in when ${c.first} called at ${hm(a.start)}.${note ? " " + note : ""}`, user, { silent: true });
      if (input.rebook) {
        const wid = newId("w"), seq = one("SELECT COALESCE(MAX(added_seq), 0) + 1 AS s FROM waitlist").s;
        run("UPDATE waitlist SET status = 'booked' WHERE patient_id = ? AND status = 'waiting'", p.id);
        run("INSERT INTO waitlist (id, patient_id, type, prio, days, avail, short_notice, added_seq, note) VALUES (?, ?, ?, 'soon', 0, 'any', 1, ?, ?)", wid, p.id, a.type, seq, "Not in at their last visit");
        rebooked = wid;
        bus.emit({ type: "waitlist.added", waitlistId: wid });
      }
    }
    audit(user.name, "appointment.recorded", a.id, `${p.name} ${hm(a.start)} with ${c.name}: ${outcome === "done" ? "completed" : "nobody in"} (recorded by the office)`);
    bus.emit({ type: "appointment.updated", clinicianId: c.id, appointmentId: a.id, status: outcome });
    return { ...getAppt(a.id), invoice, rebooked };
  });
}

/** Why a clinician couldn't do a visit, as it's written on the patient's record. */
const NOT_DONE = { nobody: "Nobody in", unwell: "Patient unwell", declined: "Patient declined the visit", access: "Couldn't get access" };
/**
 * The clinician couldn't do the visit: nobody in, the patient was unwell, declined, or there was no way in.
 * Recorded from the doorstep so the office doesn't have to be phoned. No sight test happened, so PCSE's
 * notification is withdrawn; the patient goes back on the waiting list unless the clinician says not to.
 */
function notDone(id, input, user) {
  return tx(() => {
    const a = getAppt(String(id));
    if (!a) throw new HttpError(404, "That visit no longer exists.");
    if (user.role === "clinician" && a.clinicianId !== user.clinicianId) throw new HttpError(403, "This visit is on another clinician's round.");
    if (a.day !== 0) throw new HttpError(409, `That visit is on ${cal.label(a.day)}, not today.`);
    if (!["booked", "enroute", "live"].includes(a.status)) throw new HttpError(409, `That visit is already ${a.status === "done" ? "complete" : a.status}.`);
    if (a.status === "booked" && a.start > sandbox.nowMin()) throw new HttpError(409, "That visit hasn't started yet. Mark it once you're there.");
    const reason = NOT_DONE[input.reason];
    if (!reason) throw new HttpError(400, "Choose what happened.");
    const p = getPatient(a.patientId), c = getClinician(a.clinicianId), note = clean(input.note, 1000);
    run("UPDATE appointments SET status = 'missed', seen = 1, reason = ? WHERE id = ?", reason, a.id);
    pcseTask("cancel", a, p);
    diaryLog("not-seen", a, { reason });
    addNote(p.id, `${reason} when ${c.first} called at ${hm(a.start)}.${note ? " " + note : ""}`, user, { silent: true });
    let rebooked = null;
    if (input.rebook !== false) {
      const wid = newId("w"), seq = one("SELECT COALESCE(MAX(added_seq), 0) + 1 AS s FROM waitlist").s;
      run("UPDATE waitlist SET status = 'booked' WHERE patient_id = ? AND status = 'waiting'", p.id);
      run("INSERT INTO waitlist (id, patient_id, type, prio, days, avail, short_notice, added_seq, note) VALUES (?, ?, ?, 'soon', 0, 'any', 1, ?, ?)", wid, p.id, a.type, seq, `${reason} at their last visit`);
      rebooked = wid;
      bus.emit({ type: "waitlist.added", waitlistId: wid });
    }
    audit(user.name, "appointment.not-done", a.id, `${p.name} ${hm(a.start)} with ${c.name}: ${reason.toLowerCase()}${rebooked ? ", back on the waiting list" : ""}`);
    bus.emit({ type: "appointment.updated", clinicianId: c.id, appointmentId: a.id, status: "missed" });
    return { ...getAppt(a.id), reason, rebooked };
  });
}

/** Whether PCSE has been told about each NHS home sight test, for the clinician to see before they test. */
function pvnStatus() {
  const out = {};
  for (const r of all("SELECT appointment_id, action, status FROM pcse ORDER BY id")) out[r.appointment_id] = r.action === "lodge" ? (r.status === "done" ? "lodged" : "pending") : "cancelled";
  return out;
}

/* Filling a gap by hand: everyone who'd fit, and the office books the one it rang. */
const freedSlot = (id) => {
  const slot = getAppt(String(id));
  if (!slot || slot.status !== "cancelled") throw new HttpError(404, "That isn't a free slot.");
  if (slot.day === 0 && slot.start <= sandbox.nowMin()) throw new HttpError(409, "That time has already passed.");
  if (one("SELECT 1 FROM appointments WHERE clinician_id = ? AND day = ? AND start_min = ? AND status != 'cancelled'", slot.clinicianId, slot.day, slot.start))
    throw new HttpError(409, "That slot has already been filled.");
  return slot;
};
/** Who on the waiting list could take a freed slot, best first, including people who asked to be phoned. */
function gapCandidates(id) {
  const slot = freedSlot(id), { clinician, window, candidates } = rank(slot, declinedFor(id));
  const pending = pendingFor(slot.id).map((o) => map.wait(one("SELECT * FROM waitlist WHERE id = ?", o.waitlist_id)).patientId);
  // Who the office has already rung for this slot, so nobody is rung twice.
  const rung = all("SELECT o.status, o.deadline, w.patient_id FROM offers o JOIN waitlist w ON w.id = o.waitlist_id WHERE o.slot_id = ? AND o.status = 'declined' AND o.round = 0 ORDER BY o.id", slot.id)
    .map((r) => ({ name: getPatient(r.patient_id).name, outcome: r.deadline === "no-answer" ? "No answer" : "Not interested" }));
  return { slotId: slot.id, clinicianId: clinician.id, clinician: clinician.name, day: slot.day, start: slot.start, type: slot.type, window, candidates, offeredTo: pending.map((pid) => getPatient(pid).name), rung, mode: settings().mode };
}
/** The office rang someone on the list: no answer, or they don't want it. They drop off the list for this slot only. */
function skipCandidate(id, waitlistId, outcome, user) {
  return tx(() => {
    const slot = freedSlot(id);
    if (!["no-answer", "declined"].includes(outcome)) throw new HttpError(400, "Choose no answer or not interested.");
    const w = one("SELECT * FROM waitlist WHERE id = ? AND status = 'waiting'", String(waitlistId || ""));
    if (!w) throw new HttpError(409, "They're no longer waiting.");
    // Kept with the slot's offers (round 0: rung by the office, not texted), so ranking leaves them out next time.
    run("INSERT INTO offers (slot_id, waitlist_id, status, round, sent_at, expires_at, deadline) VALUES (?, ?, 'declined', 0, ?, ?, ?)", slot.id, w.id, Date.now(), Date.now(), outcome);
    audit(user.name, "call-list." + outcome, slot.id, `${getPatient(w.patient_id).name}: ${outcome === "no-answer" ? "no answer" : "not interested"} for ${cal.label(slot.day)} ${hm(slot.start)}`);
    bus.emit({ type: "slot.unfilled", slotId: slot.id });
    return { ok: true };
  });
}
/** The office rang someone (usually a patient who can't take texts) and they said yes: book them straight in. */
function bookCandidate(id, waitlistId, user) {
  return tx(() => {
    const slot = freedSlot(id);
    const cand = rank(slot, []).candidates.find((x) => x.waitlistId === String(waitlistId || ""));
    if (!cand) throw new HttpError(409, "They're no longer waiting: they may have just been booked or offered another visit.");
    if (!cand.ok) throw new HttpError(409, `${cand.name} can't take this slot: ${cand.reason.charAt(0).toLowerCase() + cand.reason.slice(1)}.`);
    const done = book(slot, cand.waitlistId, null, user.name, "office");
    // The call that worked, kept with the unanswered ones, so the pilot can count calls per refill.
    run("INSERT INTO offers (slot_id, waitlist_id, status, round, sent_at, expires_at, booked_appointment_id) VALUES (?, ?, 'accepted', 0, ?, ?, ?)", slot.id, cand.waitlistId, Date.now(), Date.now(), done.appointmentId);
    return done;
  });
}

/* ---------- Cancellation link for patients and families ---------- */
/** The private link that cancels one visit, for a relative who doesn't text. Null until the app knows its address. */
function cancelLink(apptId) {
  const sb = sandbox.current();
  let r = one("SELECT cancel_token FROM appointments WHERE id = ?", apptId);
  if (!r) return null;
  if (!r.cancel_token) { const tok = crypto.randomBytes(16).toString("base64url"); run("UPDATE appointments SET cancel_token = ? WHERE id = ?", tok, apptId); r = { cancel_token: tok }; }
  return sb.base ? `${sb.base}/cancel/${sb.id}/${r.cancel_token}` : null;
}
function officeCancelLink(id, user) {
  return tx(() => {
    const a = getAppt(String(id));
    if (!a) throw new HttpError(404, "That visit no longer exists.");
    if (a.status !== "booked") throw new HttpError(409, "Only visits that haven't started can be cancelled online.");
    const url = cancelLink(a.id);
    audit(user.name, "appointment.cancel-link", a.id, "Cancellation link copied for the family");
    return { url };
  });
}
const byToken = (token) => {
  const r = /^[A-Za-z0-9_-]{16,64}$/.test(String(token || "")) && one("SELECT * FROM appointments WHERE cancel_token = ?", String(token));
  if (!r) throw new HttpError(404, "This link isn't valid any more. Please call us to change the visit.");
  return map.appt(r);
};
/** What the cancellation page shows: initials only, so a forwarded link reveals as little as possible. */
function publicVisit(token) {
  const a = byToken(token), p = getPatient(a.patientId), c = getClinician(a.clinicianId);
  const started = a.day === 0 && a.start <= sandbox.nowMin();
  const state = a.status === "cancelled" ? "cancelled" : a.status !== "booked" ? "started" : started ? "past" : "booked";
  const initials = p.name.split(" ").map((w, i, all) => (i === all.length - 1 ? w : w[0] + ".")).join(" ");
  return { state, patient: initials, when: when(a.day, a.start), visit: TYPES[a.type].name, clinician: c.first, reasons: REASONS };
}
function publicCancel(token, input) {
  return tx(() => {
    const v = publicVisit(token), a = byToken(token);
    if (v.state === "cancelled") throw new HttpError(409, "This visit is already cancelled.");
    if (v.state !== "booked") throw new HttpError(409, `${v.clinician} is already on the way or has been. Please call us instead.`);
    const reason = REASONS.includes(input.reason) ? input.reason : "Patient asked to rebook";
    return { ok: true, refill: cancelAppointment(a.id, reason, "Cancellation link", { byLink: true }).outcome };
  });
}

/* ---------- The team: clinicians, office staff, working hours ---------- */
const ROLES = ["Optometrist", "Dispensing optician"];
const userOf = (cid) => one("SELECT * FROM users WHERE clinician_id = ?", cid);
function teamList() {
  const users = all("SELECT * FROM users ORDER BY role, name").map(map.user);
  return {
    clinicians: all("SELECT * FROM clinicians ORDER BY active DESC, rowid").map(map.clinician).map((c) => { const u = users.find((x) => x.clinicianId === c.id) || {}; return { ...c, email: u.email || null, userId: u.id || null, office: u.role === "clinician" && !!u.office }; }),
    staff: users.filter((u) => u.role === "admin"),
    roles: ROLES,
  };
}
const validEmail = (v) => { const e = clean(v, 120).toLowerCase(); if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw new HttpError(400, "Enter a valid email address for signing in."); return e; };
const emailTaken = (email, exceptUser) => one("SELECT 1 FROM users WHERE email = ? AND id IS NOT ?", email, exceptUser);
const districts = (v) => {
  const list = (Array.isArray(v) ? v : String(v || "").split(/[\s,]+/)).map((d) => String(d).trim().toUpperCase()).filter(Boolean);
  const bad = list.filter((d) => !/^[A-Z]{1,2}\d{1,2}[A-Z]?$/.test(d) || !travel.known(d));
  if (bad.length) throw new HttpError(400, `We don't know the postcode area${bad.length === 1 ? "" : "s"} ${bad.join(", ")}.`);
  return [...new Set(list)];
};
/** Working hours Mon–Fri: each [start, end] inside the practice's opening hours, at least an hour, or null for a day off. */
/** A new account's password: random and never known, so nobody can sign in until the person opens their invitation
 *  (server/invites.js) and chooses their own, with their own authenticator app. */
const newAccountHash = () => auth.hashPassword(crypto.randomBytes(24).toString("base64url"));

function workingHours(v) {
  if (!Array.isArray(v) || v.length !== 5) throw new HttpError(400, "Set hours for each day, Monday to Friday.");
  const { dayStart, dayEnd } = settings();
  return v.map((h, i) => {
    if (h == null) return null;
    const [s, e] = [Number(h[0]), Number(h[1])];
    if (!(s % 15 === 0 && e % 15 === 0 && s >= dayStart && e <= dayEnd && e - s >= 60)) throw new HttpError(400, `${cal.WEEKDAYS[i].slice(0, 3)}: hours must be between ${hm(dayStart)} and ${hm(dayEnd)} (the practice's opening hours), at least an hour, in quarter hours.`);
    return [s, e];
  });
}

/** Add a clinician (with their sign-in account), or change one. Refuses changes that would strand booked visits. */
function saveClinician(input, user) {
  return tx(() => {
    const existing = input.id ? getClinician(String(input.id)) : null;
    if (input.id && !existing) throw new HttpError(404, "No such clinician.");
    const name = clean(input.name, 60); if (name.length < 2) throw new HttpError(400, "Enter their full name.");
    const role = ROLES.includes(input.role) ? input.role : null; if (!role) throw new HttpError(400, "Choose optometrist or dispensing optician.");
    const color = /^#[0-9a-f]{6}$/i.test(String(input.color || "")) ? input.color : (existing ? existing.color : "#0B3B7C");
    const areaName = clean(input.areaName, 60) || "Their area";
    const patch = districts(input.patch); if (!patch.length) throw new HttpError(400, "Add at least one postcode area they cover, like BL1.");
    const near = districts(input.near).filter((d) => !patch.includes(d));
    const base = travel.normalise(input.base); if (!travel.known(base)) throw new HttpError(400, "Enter the postcode they start from (home or the practice).");
    const hours = workingHours(input.hours);
    const clash = (where, ...args) => all(`SELECT a.*, p.name FROM appointments a JOIN patients p ON p.id = a.patient_id WHERE a.clinician_id = ? AND a.status = 'booked' ${where}`, existing && existing.id, ...args);
    if (existing) {
      if (role !== "Optometrist" && existing.optom) {
        const tests = clash("").filter((a) => TYPES[a.type].optom);
        if (tests.length) throw new HttpError(409, `${existing.first} has ${tests.length} eye test${tests.length === 1 ? "" : "s"} or check${tests.length === 1 ? "" : "s"} booked that need an optometrist. Move them first.`);
      }
      const outside = clash("AND a.day >= 0").filter((a) => { const h = cal.isOpen(a.day) ? hours[cal.weekday(a.day)] : null; return !h || a.start_min < h[0] || a.start_min + TYPES[a.type].dur > h[1]; });
      if (outside.length) {
        const x = outside[0];
        throw new HttpError(409, `${outside.length} booked visit${outside.length === 1 ? " falls" : "s fall"} outside those hours (${x.name}, ${cal.label(x.day)} ${hm(x.start_min)}${outside.length > 1 ? ", and more" : ""}). Move ${outside.length === 1 ? "it" : "them"} first.`);
      }
    }
    const first_ = name.split(" ")[0];
    let cid = existing && existing.id;
    if (existing) {
      run("UPDATE clinicians SET name = ?, first = ?, role = ?, color = ?, area_name = ?, patch = ?, near = ?, base = ?, hours = ? WHERE id = ?", name, first_, role, color, areaName, JSON.stringify(patch), JSON.stringify(near), base, JSON.stringify(hours), cid);
      const u = userOf(cid);
      if (u) {
        const email = input.email ? validEmail(input.email) : u.email;
        if (emailTaken(email, u.id)) throw new HttpError(409, "Another account already signs in with that email.");
        run("UPDATE users SET name = ?, title = ?, color = ?, email = ? WHERE id = ?", name, role, color, email, u.id);
        if (Object.prototype.hasOwnProperty.call(input, "office") && !!u.office !== !!input.office) {
          run("UPDATE users SET office = ? WHERE id = ?", input.office ? 1 : 0, u.id);
          audit(user.name, input.office ? "user.office-on" : "user.office-off", u.id, `${name}: office access ${input.office ? "given" : "removed"}`);
        }
      }
      audit(user.name, "clinician.update", cid, name);
    } else {
      const email = validEmail(input.email);
      if (emailTaken(email, null)) throw new HttpError(409, "Another account already signs in with that email.");
      cid = newId("c");
      run("INSERT INTO clinicians (id, name, first, role, color, area_name, patch, near, base, hours) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", cid, name, first_, role, color, areaName, JSON.stringify(patch), JSON.stringify(near), base, JSON.stringify(hours));
      run("INSERT INTO users (id, name, role, clinician_id, email, pass_hash, totp_secret, title, color, office) VALUES (?, ?, 'clinician', ?, ?, ?, ?, ?, ?, ?)", "u-" + cid, name, cid, email, newAccountHash(), auth.newSecret(), role, color, input.office ? 1 : 0);
      audit(user.name, "clinician.add", cid, `${name}, ${role}`);
    }
    bus.emit({ type: "team.updated" });
    return getClinician(cid);
  });
}

/** Someone leaves (or comes back). Their history stays; they stop getting work and can't sign in. */
function setClinicianActive(id, active, user) {
  return tx(() => {
    const c = getClinician(String(id));
    if (!c) throw new HttpError(404, "No such clinician.");
    if (!active) {
      const n = one("SELECT COUNT(*) AS n FROM appointments WHERE clinician_id = ? AND status IN ('booked','enroute','live')", c.id).n;
      if (n) throw new HttpError(409, `${c.first} has ${n} visit${n === 1 ? "" : "s"} booked. Move or cancel ${n === 1 ? "it" : "them"} first.`);
      run("UPDATE waitlist SET pref_clinician_id = NULL WHERE pref_clinician_id = ?", c.id);
    }
    run("UPDATE clinicians SET active = ? WHERE id = ?", active ? 1 : 0, c.id);
    run("UPDATE users SET active = ? WHERE clinician_id = ?", active ? 1 : 0, c.id);
    audit(user.name, active ? "clinician.reactivate" : "clinician.deactivate", c.id, c.name);
    bus.emit({ type: "team.updated" });
    const u = userOf(c.id);
    return { ok: true, userId: u ? u.id : null };
  });
}

/** Office accounts: add one, or change a name, job title or sign-in email. */
function saveStaff(input, user) {
  return tx(() => {
    const existing = input.id ? one("SELECT * FROM users WHERE id = ? AND role = 'admin'", String(input.id)) : null;
    if (input.id && !existing) throw new HttpError(404, "No such office account.");
    const name = clean(input.name, 60); if (name.length < 2) throw new HttpError(400, "Enter their full name.");
    const title = clean(input.title, 60) || "Office";
    const email = validEmail(input.email);
    if (emailTaken(email, existing ? existing.id : null)) throw new HttpError(409, "Another account already signs in with that email.");
    let id = existing && existing.id;
    if (existing) { run("UPDATE users SET name = ?, title = ?, email = ? WHERE id = ?", name, title, email, id); audit(user.name, "staff.update", id, name); }
    else {
      id = newId("u-");
      run("INSERT INTO users (id, name, role, clinician_id, email, pass_hash, totp_secret, title, color) VALUES (?, ?, 'admin', NULL, ?, ?, ?, ?, ?)", id, name, email, newAccountHash(), auth.newSecret(), title, "#5B6770");
      audit(user.name, "staff.add", id, `${name}, ${title}`);
    }
    bus.emit({ type: "team.updated" });
    return map.user(one("SELECT * FROM users WHERE id = ?", id));
  });
}
function setStaffActive(id, active, user) {
  return tx(() => {
    const u = one("SELECT * FROM users WHERE id = ? AND role = 'admin'", String(id));
    if (!u) throw new HttpError(404, "No such office account.");
    if (!active && u.id === user.id) throw new HttpError(409, "You can't switch off your own account.");
    if (!active && one("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1 AND id != ?", u.id).n === 0) throw new HttpError(409, "The practice needs at least one office account.");
    run("UPDATE users SET active = ? WHERE id = ?", active ? 1 : 0, u.id);
    audit(user.name, active ? "staff.reactivate" : "staff.deactivate", u.id, u.name);
    bus.emit({ type: "team.updated" });
    return { ok: true, userId: u.id };
  });
}

module.exports = { reports, reportPeriod, recordSale, saveSale, saleOf, NO_SALE, setAvailability, diaryChanges, markDiaryCopied, skipCandidate, lodgePvn, setPvnDetails, validNhsNumber, setLikelihood, sourceFor, nhsFrom, sweepRecalls, notDone, pvnStatus, NOT_DONE, saveSettings, messagePreviews, createPatient, updatePatient, exportPatient, erasePatient, moveOptions, moveAppointment, recordOutcome, gapCandidates, bookCandidate, officeCancelLink, publicVisit, publicCancel, teamList, saveClinician, setClinicianActive, saveStaff, setStaffActive, submitReferral, acceptReferral, declineReferral, referralOptions, planRoute, applyRoute, previewImport, commitImport, pcseList, completePcse, invoiceList, payInvoice, voidInvoice, getInvoice, weekReport, textRecall, dismissRecall, publicFindSlots, publicBook, onlineTypes, routeFor, sendReminders, sweepReminders, findSlots, bookVisit, settings, HttpError, cancelAppointment, handleInbound, sweepExpired, setStatus, addNote, addToWaitlist, rank, metrics, getAppt, getPatient, getClinician, audit, tx };
