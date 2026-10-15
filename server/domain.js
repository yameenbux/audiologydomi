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

/**
 * NHS domiciliary sight tests in England need a pre-visit notification (PVN) to PCSE at least 48 hours
 * before the visit, for one or two patients at an address (GOS regulations; weekends and bank holidays
 * don't count). The demo week is Monday to Friday, so 48 hours on the demo clock is two working days.
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

// The demo week: day 0 is "today", Monday 12 October, through Friday.
const DAYS = ["Mon 12 Oct", "Tue 13 Oct", "Wed 14 Oct", "Thu 15 Oct", "Fri 16 Oct"];
const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
/** How a text should refer to a day: "today", "tomorrow", or "on Wednesday 14 Oct". */
const dayPhrase = (day) => (day === 0 ? "today" : day === 1 ? "tomorrow" : `on ${DAY_NAMES[day]} ${DAYS[day].slice(4)}`);

const hm = (m) => String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0");
const district = (pc) => String(pc).trim().split(" ")[0].toUpperCase();
const first = (n) => String(n).split(" ")[0];

module.exports = { DAY_START, DAY_END, DAYS, DAY_NAMES, dayPhrase, TYPES, PVN_NOTICE_MIN, canDo, PRIO, AVAIL, REASONS, hm, district, first };
