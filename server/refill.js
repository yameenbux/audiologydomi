"use strict";
// The refill engine. Pure functions with no database access, so the rules are easy to test and to tune.
const { DAY_START, DAY_END, TYPES, PRIO, PVN_NOTICE_MIN, canDo, district, hm } = require("./domain");
const { driveMinutes, driveInfo } = require("./travel");

/**
 * Minutes free from the start of a cancelled slot until the clinician must leave for the next visit.
 * @param {object} slot      the cancelled appointment {id, start, clinicianId}
 * @param {object[]} dayAppts the clinician's other active appointments today
 */
function freeWindow(slot, dayAppts) {
  const next = dayAppts
    .filter((a) => a.id !== slot.id && a.start > slot.start)
    .sort((a, b) => a.start - b.start)[0];
  const end = next ? next.start - (next.drive || 10) : DAY_END;
  return Math.max(0, end - slot.start);
}

/**
 * Rank everyone on the waiting list for a freed slot.
 * Hard rules decide who is eligible; soft rules decide the order.
 * Returns every entry with `ok`, `score`, `why` (reasons for) and `reason` (why not).
 * @param {number} [leadMin] minutes from now until the slot starts; NHS sight tests need PVN_NOTICE_MIN of it
 */
function rankCandidates({ slot, clinician, dayAppts, waitlist, patientsById, declined = [], sameDay = true, leadMin = Infinity }) {
  const win = freeWindow(slot, dayAppts);
  const out = [];
  for (const w of waitlist) {
    if (w.status !== "waiting" || declined.includes(w.id)) continue;
    const p = patientsById[w.patientId];
    const t = TYPES[w.type];
    const d = district(p.pc);
    const why = [];
    let ok = true;
    let reason = "";
    let score = PRIO[w.prio].pts;

    if (!canDo(clinician, w.type)) { ok = false; reason = `Needs an optometrist; ${clinician.first} dispenses`; }
    else if (t.pvn && leadMin < PVN_NOTICE_MIN) { ok = false; reason = "NHS test: PCSE needs 48h notice"; }
    else if (p.contact === "Call") { ok = false; reason = "Asked for calls, not texts: the office rings them"; }
    else if (!w.shortNotice && sameDay) { ok = false; reason = "Needs 24h notice"; }
    else if (t.dur > win) { ok = false; reason = `Needs ${t.dur} min, slot is ${win}`; }
    else if (w.avail === "am" && slot.start >= 720) { ok = false; reason = "Mornings only"; }
    else if (w.avail === "pm" && slot.start < 720) { ok = false; reason = "Afternoons only"; }
    else if (clinician.patch.includes(d)) { score += 20; why.push(`In ${clinician.first}'s patch (${d})`); }
    else if (clinician.near.includes(d)) { score += 6; why.push(`Neighbouring area (${d})`); }
    else { ok = false; reason = `${d} is outside ${clinician.first}'s area`; }

    if (ok) {
      why.unshift(`${PRIO[w.prio].label} priority`);
      score += Math.round(w.days * 0.6);
      why.push(w.source === "recall" ? (w.days ? `Recall ${w.days} days overdue` : `Recall due: ${(w.note || "review").toLowerCase()}`) : `Waiting ${w.days} days`);
      if (w.prefClinicianId === clinician.id) { score += 10; why.push(`Prefers ${clinician.first}`); }
      why.push(`Fits ${t.dur} of ${win} min`);
      if (t.pvn) why.push("PCSE notice to lodge if booked");
    }
    out.push({ waitlistId: w.id, patientId: p.id, name: p.name, type: w.type, ok, score: ok ? score : 0, why, reason });
  }
  return { window: win, candidates: out.sort((a, b) => (b.ok - a.ok) || (b.score - a.score)) };
}

/**
 * Decide how to offer a freed slot, given how soon it starts.
 * The patient must be confirmed before the clinician has to set off, so the reply window shrinks as the
 * visit gets closer. Under an hour of slack, the top few are asked at once and the first YES wins.
 * @param {number} leadMin      minutes from now until the visit starts
 * @param {number} drive        minutes the clinician needs to get there
 * @param {number} offerMinutes the office's normal reply window
 * @param {number} eligible     how many suitable patients are waiting
 */
const PREP_MIN = 10;
const PARALLEL_BELOW = 60;
function planOffer({ leadMin, drive, offerMinutes, eligible }) {
  const slack = leadMin - (drive || 0) - PREP_MIN;
  if (!eligible) return { mode: "none", slack };
  if (slack < 3) return { mode: "too-late", slack };
  if (slack < PARALLEL_BELOW) {
    return { mode: "parallel", count: Math.min(3, eligible), windowMin: Math.max(2, Math.min(offerMinutes, Math.floor(slack / 2))), slack };
  }
  // Leave time for at least three rounds before the clinician must leave.
  return { mode: "single", count: 1, windowMin: Math.max(5, Math.min(offerMinutes, Math.floor(slack / 3))), slack };
}

/** Read a patient's text. "cancel" is only returned for an explicit cancellation. */
function parseReply(body) {
  const s = String(body || "").trim().toLowerCase();
  if (/\bcancel/.test(s)) return "cancel";
  if (/^(y|yes|yeah|yep|ok|okay|please|yes please)\b/.test(s)) return "yes";
  if (/^(n|no|nope|can't|cannot|can not|not today|i can't|i cannot)\b/.test(s)) return "no";
  return "unknown";
}


/**
 * Best places to fit a new home visit into this week's rounds (today plus the following working days).
 * For every gap in every clinician's day, the visit must fit with the drive in from the previous visit
 * and the drive on to the next one. Options are ranked by the extra driving they add to the round.
 * @param {object} p
 * @param {string} p.pc            the patient's postcode
 * @param {string} p.type          visit type key
 * @param {"any"|"am"|"pm"} p.avail when the patient is home
 * @param {object[]} p.clinicians   [{id, first, patch, near}]
 * @param {object[]} p.appts        active appointments this week: {id, clinicianId, day, start, type, pc, name}
 * @param {number} [p.days]        how many working days to search, starting today
 * @param {number} p.now           demo time in minutes
 * @param {number} [p.noticeMin]   how much warning the patient needs
 * @param {string} [p.prio]        waiting-list priority; urgent patients are pulled towards sooner days
 */
const ROUND5 = (m) => Math.ceil(m / 5) * 5;
// Points lost per day later. The more urgent the patient, the more a sooner visit is worth against extra driving.
const DAY_PENALTY = { urgent: 25, soon: 14, routine: 6 };
function suggestSlots({ pc, type, avail = "any", clinicians, appts, now, noticeMin = 30, days = 5, prio = "routine" }) {
  const perDay = DAY_PENALTY[prio] || DAY_PENALTY.routine;
  const dur = TYPES[type].dur;
  // An NHS sight test can't start until PCSE has had 48 hours' notice of it.
  const pvnFrom = TYPES[type].pvn ? now + PVN_NOTICE_MIN : -Infinity;
  const d = district(pc);
  const out = [];
  for (let day = 0; day < days; day++) {
  const earliestAllowed = ROUND5(Math.max(day === 0 ? Math.max(DAY_START, now + noticeMin) : DAY_START, pvnFrom - day * 1440));
  for (const c of clinicians) {
    if (!canDo(c, type)) continue;
    const area = c.patch.includes(d) ? "patch" : c.near.includes(d) ? "near" : "outside";
    if (area === "outside") continue; // too far to be worth fitting in
    const round = appts.filter((a) => a.clinicianId === c.id && (a.day || 0) === day).sort((x, y) => x.start - y.start);
    const base = { pc: c.base || c.patch[0], name: "start of round", end: DAY_START };
    const stops = [base, ...round.map((a) => ({ pc: a.pc, name: a.name, start: a.start, end: a.start + TYPES[a.type].dur }))];
    for (let i = 0; i < stops.length; i++) {
      const prev = stops[i], next = stops[i + 1] || null;
      const driveIn = driveMinutes(prev.pc, pc);
      const driveOut = next ? driveMinutes(pc, next.pc) : 0;
      if (driveIn == null || driveOut == null) continue;
      let start = ROUND5(Math.max(prev.end + driveIn, earliestAllowed));
      if (avail === "pm") start = Math.max(start, 12 * 60);
      const latestEnd = next ? next.start - driveOut : DAY_END;
      if (start + dur > latestEnd) continue;
      if (avail === "am" && start >= 12 * 60) continue;
      const direct = next ? driveMinutes(prev.pc, next.pc) || 0 : 0;
      // Last visit of the day: the drive home changes too, so count the difference.
      const home = (from) => (from === base.pc ? 0 : driveMinutes(from, base.pc) || 0);
      const homeDelta = next ? 0 : home(pc) - home(prev.pc);
      const extraDrive = Math.max(0, driveIn + driveOut - direct + homeDelta);
      // "road" only when every leg of the detour is a real road route
      const legs = [driveInfo(prev.pc, pc), next && driveInfo(pc, next.pc)].filter(Boolean);
      const route = legs.every((l) => l.source === "road") ? "road" : "estimate";
      const why = [`${extraDrive} min extra driving`];
      why.push(area === "patch" ? `In ${c.first}'s patch (${d})` : `Next to ${c.first}'s patch (${d})`);
      why.push(next ? `Between ${prev.name} and ${next.name}` : prev === base ? "Only visit that day" : `Last visit, after ${prev.name}`);
      // Fewer extra miles first; then the clinician's own patch; then sooner.
      const score = 100 - extraDrive * 2 + (area === "patch" ? 10 : 0) - day * perDay - Math.round((start - DAY_START) / 120);
      out.push({ clinicianId: c.id, day, start, end: start + dur, driveIn, driveOut, extraDrive, area, prev: prev.name, next: next ? next.name : null, score, why, route, label: `${hm(start)}–${hm(start + dur)}` });
    }
  }
  }
  out.sort((a, b) => b.score - a.score);
  // If the best option isn't the shortest drive, say why: it's sooner.
  const [top] = out;
  const cheapest = out.reduce((m, x) => (x.extraDrive < m.extraDrive ? x : m), top || {});
  if (top && cheapest.extraDrive < top.extraDrive && cheapest.day > top.day) {
    const n = cheapest.day - top.day;
    top.why.push(`${n === 1 ? "A day" : n + " days"} sooner than the shortest drive (${PRIO[prio] ? PRIO[prio].label : "Routine"} priority)`);
  }
  return out;
}

module.exports = { freeWindow, rankCandidates, parseReply, planOffer, suggestSlots };
