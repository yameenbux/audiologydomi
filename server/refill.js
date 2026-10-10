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

/** Read a patient's text reply. Generous with wording, strict with ambiguity. */
function parseReply(body) {
  const s = String(body || "").trim().toLowerCase();
  if (/^(y|yes|yeah|yep|ok|okay|please|yes please)\b/.test(s)) return "yes";
  if (/^(n|no|nope|can't|cannot|not today)\b/.test(s)) return "no";
  return "unknown";
}

module.exports = { freeWindow, rankCandidates, parseReply };
