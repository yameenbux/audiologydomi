"use strict";
// The refill engine. Pure functions with no database access, so the rules are easy to test and to tune.
const { DAY_END, TYPES, PRIO, district } = require("./domain");

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
 */
function rankCandidates({ slot, clinician, dayAppts, waitlist, patientsById, declined = [] }) {
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

    if (!w.shortNotice) { ok = false; reason = "Needs 24h notice"; }
    else if (t.dur > win) { ok = false; reason = `Needs ${t.dur} min, slot is ${win}`; }
    else if (w.avail === "am" && slot.start >= 720) { ok = false; reason = "Mornings only"; }
    else if (w.avail === "pm" && slot.start < 720) { ok = false; reason = "Afternoons only"; }
    else if (clinician.patch.includes(d)) { score += 20; why.push(`In ${clinician.first}'s patch (${d})`); }
    else if (clinician.near.includes(d)) { score += 6; why.push(`Neighbouring area (${d})`); }
    else { ok = false; reason = `${d} is outside ${clinician.first}'s area`; }

    if (ok) {
      why.unshift(`${PRIO[w.prio].label} priority`);
      score += Math.round(w.days * 0.6);
      why.push(`Waiting ${w.days} days`);
      if (w.prefClinicianId === clinician.id) { score += 10; why.push(`Prefers ${clinician.first}`); }
      why.push(`Fits ${t.dur} of ${win} min`);
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

module.exports = { freeWindow, rankCandidates, parseReply, planOffer };
