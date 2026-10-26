"use strict";
// Shared domain vocabulary. Served to the browser via GET /api/meta so both sides agree.

const DAY_START = 9 * 60;
const DAY_END = 17 * 60 + 30; // 17:30, when Home Visiting Optics finish

// The practice's visit types come from its sector (server/sectors.js): five fixed slots with the sector's names,
// lengths and rules. Each type has:
//   optom: only the team's lead role can do it (an optometrist, an audiologist, a podiatrist...). The name is kept
//          from when Domi was for opticians only; it means "lead clinician only" in every sector.
//   pvn:   an NHS sight test, so PCSE must be told about the visit in advance (see PVN_NOTICE_MIN). Opticians only.
// Each practice sets its own visit lengths (Settings > Visits & prices). `dur` reads the practice in context, so
// booking, refills, route planning and the diary all use the same length; outside a practice, the sector's default.
const sectors = require("./sectors");
const typesOf = new Map(); // sector id -> its five types, built once
function sectorTypes(sec) {
  if (typesOf.has(sec.id)) return typesOf.get(sec.id);
  const out = {};
  for (const k of sectors.KEYS) {
    const t = sec.types[k];
    out[k] = { name: t.name, optom: !!t.lead, ...(t.pvn && sec.modules.pcse ? { pvn: true } : {}) };
    Object.defineProperty(out[k], "dur", { enumerable: true, get() {
      let sb = null; try { sb = require("./sandbox").current(); } catch { /* not inside a practice */ }
      const v = sb && sb.settings && sb.settings.durations ? Number(sb.settings.durations[k]) : NaN;
      return Number.isFinite(v) && v > 0 ? v : t.dur;
    } });
  }
  typesOf.set(sec.id, out);
  return out;
}
// TYPES[k] is the type for the practice in context, so every caller follows the practice's sector.
const TYPES = new Proxy({}, {
  get: (_, k) => sectorTypes(sectors.current())[k],
  has: (_, k) => sectors.KEYS.includes(k),
  ownKeys: () => [...sectors.KEYS],
  getOwnPropertyDescriptor: (_, k) => (sectors.KEYS.includes(k) ? { value: sectorTypes(sectors.current())[k], enumerable: true, configurable: true } : undefined),
});
// The sector's own lengths, before a practice changes them.
const DEFAULT_DUR = new Proxy({}, { get: (_, k) => (sectors.current().types[k] || {}).dur });

/**
 * NHS domiciliary sight tests in England need a pre-visit notification (PVN) to PCSE at least 48 hours
 * before the visit, for one or two patients at an address (GOS regulations; weekends and bank holidays
 * don't count, so Domi counts working hours: see calendar.workMinutesUntil).
 * Inside that, the practice needs its ICB's approval first, so Domi doesn't offer the slot by text.
 */
const PVN_NOTICE_MIN = 48 * 60;
/** Whether this clinician can do this kind of visit. */
const canDo = (clinician, type) => !TYPES[type].optom || !!clinician.optom;

/**
 * Where a booking came from, and how likely it is to go ahead: Home Visiting Optics' "true count". A recall (seen by
 * the practice last time) is 1; an old recall, a new patient, a Facebook lead or a referral is 0.5. The office can
 * change a visit's count when they know better. Adding up a clinic's counts says how strong it is.
 */
const SOURCES = {
  recall: { label: "Recall", count: 1 },
  "old-recall": { label: "Old recall (2+ years)", count: 0.5 },
  facebook: { label: "Facebook", count: 0.5 },
  referral: { label: "Referral", count: 0.5 },
  new: { label: "New patient", count: 0.5 },
};
const COUNTS = [1, 0.75, 0.5, 0.25, 0];
const trueCount = (a) => (a.reliability != null ? a.reliability : (SOURCES[a.source] || SOURCES.new).count);

const PRIO = {
  urgent: { label: "Urgent", pts: 50 },
  soon: { label: "Soon", pts: 30 },
  routine: { label: "Routine", pts: 10 },
};

const AVAIL = { any: "Home all day", am: "Mornings only", pm: "Afternoons only" };

// When a patient can be seen, as the office records it on a visit (and, for a standing arrangement, on the patient):
// a day centre in the mornings, a carer only after two, a hospital transport at 11. The route planner, moving a
// visit and booking all keep to it. `at` is minutes from midnight.
const TW = { am: "Mornings only", pm: "Afternoons only", after: "Not before", before: "No later than", fixed: "Only at" };
const NOON = 12 * 60;
// "between" isn't offered to the office: it's the arrival window a patient has already been given (CC2), which an
// automatic re-plan keeps to.
const twLabel = (tw) => (!tw ? "" : tw.k === "between" ? `Told ${hm(tw.at)}–${hm(tw.to)}` : !TW[tw.k] ? "" : tw.k === "am" || tw.k === "pm" ? TW[tw.k] : `${TW[tw.k]} ${hm(tw.at)}`);
const twAllows = (tw, start) => !tw ? true : tw.k === "between" ? start >= tw.at && start <= tw.to : !TW[tw.k] ? true
  : tw.k === "am" ? start < NOON : tw.k === "pm" ? start >= NOON : tw.k === "after" ? start >= tw.at : tw.k === "before" ? start <= tw.at : start === tw.at;
/** A restriction from user input: null for "any time"; throws a message for anything else that doesn't make sense. */
function twParse(k, at) {
  if (!k || k === "any") return null;
  if (!TW[k]) throw new Error("Choose when the patient can be seen.");
  if (k === "am" || k === "pm") return { k, at: null };
  const n = Number(at);
  if (!Number.isInteger(n) || n % 5 || n < 7 * 60 || n > 20 * 60) throw new Error("Choose a time between 07:00 and 20:00, on the 5 minutes.");
  return { k, at: n };
}

const REASONS = ["Patient unwell", "Admitted to hospital", "Patient asked to rebook", "Carer or family can't be present"];

// Dates, weekends and bank holidays: server/calendar.js. Clinicians' hours are set per weekday, Monday to Friday.
const WORK_WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];

const hm = (m) => String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0");
const district = (pc) => String(pc).trim().split(" ")[0].toUpperCase();
const first = (n) => String(n).split(" ")[0];

module.exports = { TW, twLabel, twAllows, twParse, SOURCES, COUNTS, trueCount, DEFAULT_DUR, DAY_START, DAY_END, WORK_WEEKDAYS, TYPES, PVN_NOTICE_MIN, canDo, PRIO, AVAIL, REASONS, hm, district, first };
