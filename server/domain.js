"use strict";
// Shared domain vocabulary. Served to the browser via GET /api/meta so both sides agree.

const DAY_START = 9 * 60;
const DAY_END = 17 * 60 + 30; // 17:30, when Home Visiting Optics finish

// optom: only an optometrist can do it (a dispensing optician can't test eyes).
// pvn: an NHS sight test, so PCSE must be told about the visit in advance (see PVN_NOTICE_MIN).
const TYPES = {
  sight: { name: "NHS sight test", dur: 60, optom: true, pvn: true },
  exam: { name: "Private eye examination", dur: 60, optom: true },
  dispense: { name: "Glasses delivery & fitting", dur: 30 },
  repair: { name: "Repair & adjustment", dur: 20 },
  follow: { name: "Follow-up check", dur: 30, optom: true },
};
// Each practice sets its own visit lengths (Settings > Visits & prices). `dur` reads the practice in context, so
// booking, refills, route planning and the diary all use the same length; outside a practice, the default above.
const DEFAULT_DUR = Object.fromEntries(Object.entries(TYPES).map(([k, t]) => [k, t.dur]));
for (const k of Object.keys(TYPES)) {
  Object.defineProperty(TYPES[k], "dur", { enumerable: true, get() {
    let sb = null; try { sb = require("./sandbox").current(); } catch { /* not inside a practice */ }
    const v = sb && sb.settings && sb.settings.durations ? Number(sb.settings.durations[k]) : NaN;
    return Number.isFinite(v) && v > 0 ? v : DEFAULT_DUR[k];
  } });
}

/**
 * NHS domiciliary sight tests in England need a pre-visit notification (PVN) to PCSE at least 48 hours
 * before the visit, for one or two patients at an address (GOS regulations; weekends and bank holidays
 * don't count, so Domi counts working hours: see calendar.workMinutesUntil).
 * Inside that, the practice needs its ICB's approval first, so Domi doesn't offer the slot by text.
 */
const PVN_NOTICE_MIN = 48 * 60;
/** Whether this clinician can do this kind of visit. */
const canDo = (clinician, type) => !TYPES[type].optom || !!clinician.optom;

const PRIO = {
  urgent: { label: "Urgent", pts: 50 },
  soon: { label: "Soon", pts: 30 },
  routine: { label: "Routine", pts: 10 },
};

const AVAIL = { any: "Home all day", am: "Mornings only", pm: "Afternoons only" };

const REASONS = ["Patient unwell", "Admitted to hospital", "Patient asked to rebook", "Carer or family can't be present"];

// Dates, weekends and bank holidays: server/calendar.js. Clinicians' hours are set per weekday, Monday to Friday.
const WORK_WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];

const hm = (m) => String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0");
const district = (pc) => String(pc).trim().split(" ")[0].toUpperCase();
const first = (n) => String(n).split(" ")[0];

module.exports = { DEFAULT_DUR, DAY_START, DAY_END, WORK_WEEKDAYS, TYPES, PVN_NOTICE_MIN, canDo, PRIO, AVAIL, REASONS, hm, district, first };
