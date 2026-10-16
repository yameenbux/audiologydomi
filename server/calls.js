"use strict";
// Confirmation calls: how a home-visit practice makes sure the patient is in when the clinician knocks. Each visit
// gets three, the way Home Visiting Optics already work:
//
//  CC1  as soon as it's booked: introduce the visit and give the date only.
//  CC2  in the week before: a 3-hour arrival window, from the clinician's planned route (no more RouteXL by hand).
//  CC3  on the working day before: confirm the date, time and address.
//
// Each call can be ticked off, marked as no answer (it stays on the list), or sent as a text instead: the same
// words, for patients who'd rather have it in writing. A visit that has had its CC3 doesn't also get the automatic
// day-before reminder text.
const cal = require("./calendar");
const sandbox = require("./sandbox");
const { db } = require("./db");
const { sendSms } = require("./notify");
const { TYPES, hm, first } = require("./domain");
const svc = require("./service");
const bus = require("./bus");

const STAGES = {
  1: { code: "CC1", title: "New bookings", what: "Introduce the visit and give the date" },
  2: { code: "CC2", title: "The week before", what: "Give a 3-hour arrival window" },
  3: { code: "CC3", title: "The day before", what: "Confirm the date, time and address" },
};
const OUTCOMES = ["done", "no-answer", "texted"];
const all = (sql, ...a) => db.prepare(sql).all(...a);
const one = (sql, ...a) => db.prepare(sql).get(...a);
const lower = (s) => s.charAt(0).toLowerCase() + s.slice(1);

/** The 3-hour window to give in CC2: starting an hour before the planned time, on the half hour, inside the day. */
function arrivalWindow(start) {
  const st = svc.settings();
  let from = Math.max(st.dayStart, Math.floor((start - 60) / 30) * 30), to = from + 180;
  if (to > st.dayEnd) { to = Math.max(st.dayEnd, start + 30); from = Math.max(st.dayStart, to - 180); }
  return [from, to];
}

/** Which call a visit needs now, or null. CC3 on the working day before; CC2 within a week; CC1 until done. */
function stageDue(a, done) {
  if (a.status !== "booked" || a.day < 1) return null;
  const dayBefore = cal.openDays(1, 1)[0]; // the next working day: its visits get their CC3 today
  if (!done[3] && a.day <= dayBefore) return 3;
  if (!done[2] && !done[3] && a.day <= 7) return 2;
  if (!done[1] && !done[2] && !done[3]) return 1;
  return null;
}

function wording(stage, a, p, c) {
  const date = cal.longLabel(a.day), type = lower(TYPES[a.type].name), practice = svc.settings().practice, [w0, w1] = arrivalWindow(a.start_min);
  if (stage === 1) return {
    say: `${first(p.name)}'s ${type} is booked for ${date}. We'll ring again the week before with a time.`,
    text: `Hi ${first(p.name)}, it's ${practice}. Your ${type} at home is booked for ${date}. We'll be in touch the week before with a time. Can't make it? Reply CANCEL.`,
  };
  if (stage === 2) return {
    say: `${c.first} will be with you on ${date}, between ${hm(w0)} and ${hm(w1)}.`,
    text: `Hi ${first(p.name)}, it's ${practice}. ${c.first} will visit you on ${date}, between ${hm(w0)} and ${hm(w1)}, for your ${type}. Can't make it? Reply CANCEL.`,
  };
  return {
    say: `${c.first} visits ${cal.phrase(a.day)} at about ${hm(a.start_min)}, at ${p.addr}.`,
    text: `Hi ${first(p.name)}, a reminder from ${practice}: ${c.first} visits you ${cal.phrase(a.day)} at about ${hm(a.start_min)}, at ${p.addr}, for your ${type}. Can't make it? Reply CANCEL.`,
  };
}

function history(apptId) {
  return all("SELECT * FROM confirmations WHERE appointment_id = ? ORDER BY id", apptId);
}

/** Today's calls, by stage, most urgent first within each. */
function list() {
  const out = { 1: [], 2: [], 3: [] };
  const rows = all("SELECT * FROM appointments WHERE status = 'booked' AND day >= 1 ORDER BY day, start_min");
  for (const r of rows) {
    const h = history(r.id);
    const done = { 1: false, 2: false, 3: false }, tries = { 1: 0, 2: 0, 3: 0 };
    for (const x of h) { if (x.outcome === "no-answer") tries[x.stage]++; else done[x.stage] = true; }
    const stage = stageDue(r, done);
    if (!stage) continue;
    const p = svc.getPatient(r.patient_id), c = svc.getClinician(r.clinician_id);
    if (!p || p.erased) continue;
    const w = wording(stage, r, p, c), last = h.filter((x) => x.stage === stage).pop();
    out[stage].push({
      apptId: r.id, stage, day: r.day, dayLabel: cal.label(r.day), start: r.start_min, type: r.type, window: stage === 2 ? arrivalWindow(r.start_min) : null,
      patient: { id: p.id, name: p.name, phone: p.phone, contact: p.contact, rep: p.rep, addr: p.addr, pc: p.pc }, clinician: { id: c.id, name: c.name, first: c.first, color: c.color },
      tries: tries[stage], last: last ? { outcome: last.outcome, by: last.by_name, at: last.at } : null,
      earlier: Object.keys(done).filter((k) => done[k]).map(Number),
      say: w.say, text: w.text, canText: !!p.phone && p.contact !== "Call",
    });
  }
  return { stages: STAGES, calls: out, count: out[1].length + out[2].length + out[3].length };
}

/** Record a call: done, no answer (it stays on the list), or sent as a text instead. */
function record(apptId, stage, outcome, user) {
  return svc.tx(() => {
    const r = one("SELECT * FROM appointments WHERE id = ?", String(apptId));
    if (!r || r.status !== "booked") throw new svc.HttpError(404, "That visit isn't booked any more.");
    stage = Number(stage);
    if (!STAGES[stage]) throw new svc.HttpError(400, "Choose CC1, CC2 or CC3.");
    if (!OUTCOMES.includes(outcome)) throw new svc.HttpError(400, "Choose done, no answer or text.");
    const p = svc.getPatient(r.patient_id), c = svc.getClinician(r.clinician_id);
    if (outcome === "texted") {
      if (!p.phone || p.contact === "Call") throw new svc.HttpError(409, `${first(p.name)} asked to be phoned, not texted.`);
      sendSms({ to: p.phone, name: p.name, kind: "confirm-" + stage, body: wording(stage, r, p, c).text });
    }
    db.prepare("INSERT INTO confirmations (appointment_id, stage, outcome, by_name, at) VALUES (?, ?, ?, ?, ?)").run(r.id, stage, outcome, user.name, `${cal.label(0)} ${sandbox.stamp().slice(0, 5)}`);
    // The day-before call (or its text) replaces the automatic reminder: nobody gets told twice.
    if (stage === 3 && outcome !== "no-answer") db.prepare("UPDATE appointments SET reminded = 1 WHERE id = ?").run(r.id);
    svc.audit(user.name, "call." + outcome, r.id, `${STAGES[stage].code} for ${p.name} (${cal.label(r.day)} ${hm(r.start_min)}): ${outcome === "done" ? "spoken to" : outcome === "texted" ? "sent as a text" : "no answer"}`);
    bus.emit({ type: "calls.updated" });
    return { ok: true };
  });
}

module.exports = { list, record, arrivalWindow, stageDue, STAGES };
