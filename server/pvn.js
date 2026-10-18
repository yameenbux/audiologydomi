"use strict";
// GOS6 pre-visit notifications (PVNs): telling PCSE before an NHS sight test at home. From the GOS Contracts
// Regulations 2008 (Schedule 2, paragraph 6) and PCSE's guidance:
//
//  - one or two patients at an address: at least 48 hours' notice, not counting any part of a Saturday, Sunday or
//    bank holiday;
//  - three or more at the same address (a care home, day centre; not sheltered housing, where each flat is its own
//    address): at least 3 weeks' notice, weekends included;
//  - never more than 8 weeks ahead: PCSE won't accept a notification earlier than that;
//  - shorter notice only with the ICB's prior approval, whose name goes on the PVN.
//
// A PVN covers one visit: one address on one day, naming each patient. Domi works out which visits need one, by
// when, and lays out exactly what PCSE Online's form asks for. Lodging it is still done by the office in PCSE Online
// (until PCSE accepts Domi as a connected system), and its reference is recorded back here for the GOS6 claim.
const cal = require("./calendar");
const sandbox = require("./sandbox");
const { db, map } = require("./db");
const { TYPES, hm } = require("./domain");

const WORKING_48H = 48 * 60;
const THREE_WEEKS = 21 * 1440, EIGHT_WEEKS = 56 * 1440;
const PREMISES = {
  home: { label: "Home" }, residential: { label: "Residential Home" }, nursing: { label: "Nursing Home" },
  day: { label: "Day Centre", note: "Day centres: the sight test fee only, no domiciliary fee." }, sheltered: { label: "Sheltered Housing" },
};
const ERT = {
  "1": "At risk of frequent prescription changes", "2": "Pathology likely to worsen", "3.1": "Symptoms: referred to a medical practitioner",
  "3.2": "Symptoms: changed prescription", "3.3": "Symptoms: no change or referral", "4.1": "Needs complex lenses",
  "4.2": "Corrected vision below 6/60 in one eye", "5.1": "At a medical practitioner's request", "5.2": "Managed under GOC referral rules",
  "5.3": "Protocol: seen more often for risk factors", "6": "Other unusual circumstances",
};
const all = (sql, ...a) => db.prepare(sql).all(...a);
const squash = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

/** Which address a patient is seen at, for grouping: the care home or day centre by name and postcode, or their own address. */
function venueKey(p) {
  const prem = p.premises || "home", pc = squash(p.pc);
  if (["residential", "nursing", "day"].includes(prem) && p.venue) return `v:${squash(p.venue)}:${pc}`;
  return `a:${squash(p.addr)}:${pc}`;
}

/** The notice a visit needs, given how many NHS sight tests are at the address that day. */
function requirement(size, premises) {
  const three = size >= 3 && premises !== "sheltered";
  return three
    ? { rule: "3 weeks", text: "3 or more patients at one address: at least 3 weeks' notice, weekends included", calendarMin: THREE_WEEKS }
    : { rule: "48 hours", text: "1 or 2 patients at an address: at least 48 hours' notice, not counting weekends or bank holidays", workingMin: WORKING_48H };
}
/** Minutes of notice there would be if lodged now, counted the way the rule counts them. */
function noticeLeft(req, day, start, now) {
  return req.workingMin ? cal.workMinutesUntil(day, start, now) : day * 1440 + start - now;
}
const meets = (req, day, start, now) => noticeLeft(req, day, start, now) >= (req.workingMin || req.calendarMin);
/** The latest the PVN can be lodged in time, and the earliest PCSE will take it. */
function window(req, day, start) {
  const by = req.workingMin ? cal.lodgeBy(day, start, req.workingMin) : { day: day - 21, min: start };
  return { by, from: { day: day - 56, min: start } };
}
const at = (x) => `${cal.label(x.day)} ${hm(Math.min(x.min, 1439))}`;

/** NHS sight tests booked from today on, with their patients, grouped into visits (one address, one day). */
function visits() {
  const rows = all("SELECT a.*, p.name, p.addr, p.pc, p.dob, p.nhs_no, p.premises, p.venue, p.venue_contact, p.last_test, p.recall_months, p.next_exam FROM appointments a JOIN patients p ON p.id = a.patient_id WHERE a.status IN ('booked','enroute','live') AND a.day >= 0 ORDER BY a.day, a.start_min");
  const groups = new Map();
  for (const r of rows) {
    if (!TYPES[r.type] || !TYPES[r.type].pvn) continue;
    const p = { name: r.name, addr: r.addr, pc: r.pc, premises: r.premises || "home", venue: r.venue };
    const key = `${r.day}|${venueKey(p)}`;
    if (!groups.has(key)) groups.set(key, { key, day: r.day, premises: p.premises, venue: r.venue, addr: r.addr, pc: r.pc, contact: r.venue_contact, appts: [] });
    groups.get(key).appts.push(r);
  }
  return [...groups.values()];
}

/** Whether a visit's notification is lodged: each appointment's latest PCSE task, and its reference. */
function lodged(apptId) {
  const t = db.prepare("SELECT * FROM pcse WHERE appointment_id = ? AND action = 'lodge' ORDER BY id DESC LIMIT 1").get(apptId);
  return t ? { done: t.status === "done", ref: t.ref || null, before: t.created_at === "", by: t.done_by } : { done: false };
}

const splitName = (n) => { const parts = String(n).trim().split(/\s+/); return { first: parts.slice(0, -1).join(" ") || parts[0], surname: parts.length > 1 ? parts[parts.length - 1] : "" }; };
const dateUK = (iso) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" }) : null);

/** Everything PCSE Online's PVN form asks for, for one visit, and what's still missing. */
function formFor(g) {
  const first = g.appts[0], prem = PREMISES[g.premises] || PREMISES.home;
  const contact = g.contact || (g.premises === "home" ? first.name : null);
  const missing = [];
  if (!contact) missing.push("a contact name at the premises");
  const patients = g.appts.map((a) => {
    const n = splitName(a.name), lt = a.last_test;
    const early = a.ert || null;
    const miss = [];
    if (!a.dob) miss.push("date of birth");
    if (!a.nhs_no) miss.push("NHS number");
    if (a.pvn_early && !early) miss.push("early retest code");
    return {
      apptId: a.id, patientId: a.patient_id, firstName: n.first, surname: n.surname, dob: dateUK(a.dob), nhsNumber: a.nhs_no || null,
      lastSightTest: dateUK(lt), firstTest: lt ? "No" : "First test or unknown", ertCode: early, ertText: early ? ERT[early] : null, time: hm(a.start_min), missing: miss,
    };
  });
  patients.forEach((p) => p.missing.forEach((m) => missing.push(`${p.firstName} ${p.surname}: ${m}`)));
  return {
    dateOfVisit: dateUK(cal.iso(g.day)), approxTime: hm(Math.min(...g.appts.map((a) => a.start_min))),
    postcode: g.pc, address: [g.venue && g.premises !== "home" ? g.venue : null, g.addr].filter(Boolean).join(", "),
    premisesType: prem.label, contactName: contact, icbApproval: g.appts.map((a) => a.pvn_icb).filter(Boolean)[0] || null,
    patients, missing, note: [prem.note, g.appts.length > 3 ? `PCSE Online takes 3 patients per entry: lodge the first 3, then add the rest with Amend PVN.` : null].filter(Boolean),
  };
}

/** The office's PVN list: every visit needing one, by status, with its deadline and the form's data. */
function list() {
  const now = sandbox.nowMin(), out = [];
  for (const g of visits()) {
    const req = requirement(g.appts.length, g.premises);
    const start = Math.min(...g.appts.map((a) => a.start_min));
    const w = window(req, g.day, start), form = formFor(g);
    const marks = g.appts.map((a) => ({ id: a.id, ...lodged(a.id) }));
    const allDone = marks.every((m) => m.done), someDone = marks.some((m) => m.done);
    const refs = [...new Set(marks.map((m) => m.ref).filter(Boolean))];
    const tooEarly = g.day * 1440 + start - now > EIGHT_WEEKS;
    const inTime = meets(req, g.day, start, now);
    const status = allDone ? "notified" : tooEarly ? "early" : inTime ? "todo" : "breach";
    out.push({
      key: g.key, day: g.day, dayLabel: cal.label(g.day), start, status, rule: req.rule, ruleText: req.text,
      lodgeBy: at(w.by), lodgeFrom: at(w.from), size: g.appts.length,
      clinicians: [...new Set(g.appts.map((a) => a.clinician_id))],
      lodged: marks, refs, partly: someDone && !allDone,
      icb: form.icbApproval, form,
      why: status === "breach" ? (form.icbApproval ? `Inside the ${req.rule} notice period: lodge now, with the ICB approval (${form.icbApproval}).` : `Inside the ${req.rule} notice period and not lodged. It can't go ahead as an NHS visit without the ICB's approval: get it, or move the visit.`) : null,
    });
  }
  const order = { breach: 0, todo: 1, early: 2, notified: 3 };
  out.sort((a, b) => order[a.status] - order[b.status] || a.day - b.day || a.start - b.start);
  const cancels = all("SELECT x.*, p.name FROM pcse x JOIN patients p ON p.id = x.patient_id WHERE x.action = 'cancel' AND x.status = 'todo' ORDER BY x.id")
    .map((r) => ({ id: r.id, name: r.name, day: r.day, dayLabel: cal.label(r.day), time: hm(r.start_min), ref: (db.prepare("SELECT ref FROM pcse WHERE appointment_id = ? AND action = 'lodge' AND ref IS NOT NULL ORDER BY id DESC").get(r.appointment_id) || {}).ref || null }));
  const count = (s) => out.filter((v) => v.status === s).length;
  return { visits: out, cancels, counts: { breach: count("breach"), todo: count("todo"), early: count("early"), notified: count("notified"), cancels: cancels.length }, premises: PREMISES, ert: ERT };
}

/**
 * Would booking this NHS sight test break the notice rules? Counts the other NHS sight tests at the same address that
 * day (a third one changes the rule to 3 weeks), and checks the notice left now. Null when it's fine, or the problem.
 */
function check({ patient, type, day, start, exclude = null }) {
  if (!TYPES[type] || !TYPES[type].pvn) return null;
  const key = venueKey(patient);
  const others = visits().filter((g) => g.day === day && g.key === `${day}|${key}`).flatMap((g) => g.appts).filter((a) => a.id !== exclude);
  const size = others.length + 1, prem = patient.premises || "home";
  const req = requirement(size, prem);
  const first = Math.min(start, ...others.map((a) => a.start_min));
  if (meets(req, day, first, sandbox.nowMin())) return null;
  const w = window(req, day, first);
  return {
    rule: req.rule, size,
    message: req.calendarMin
      ? `This would be NHS sight test number ${size} at ${patient.venue || patient.addr} on ${cal.label(day)}. Three or more at one address need 3 weeks' notice to PCSE (it had to be lodged by ${at(w.by)}). Book it on another day, or 3 weeks or more ahead, or record the ICB's approval for a short-notice visit.`
      : `PCSE needs 48 hours' notice of an NHS sight test at home, not counting weekends or bank holidays, and ${cal.label(day)} ${hm(start)} is too soon (it had to be lodged by ${at(w.by)}). Choose a later time, or record the ICB's approval for a short-notice visit.`,
  };
}

module.exports = { list, check, requirement, venueKey, PREMISES, ERT, WORKING_48H, THREE_WEEKS, EIGHT_WEEKS };
