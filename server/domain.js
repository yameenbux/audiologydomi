"use strict";
// Shared domain vocabulary. Served to the browser via GET /api/meta so both sides agree.

const DAY_START = 9 * 60;
const DAY_END = 17 * 60;

const TYPES = {
  assess: { name: "Hearing assessment", dur: 60 },
  fit: { name: "Hearing aid fitting", dur: 75 },
  wax: { name: "Wax removal (microsuction)", dur: 30 },
  review: { name: "Aid review & retube", dur: 30 },
  follow: { name: "Follow-up", dur: 45 },
};

const PRIO = {
  urgent: { label: "Urgent", pts: 50 },
  soon: { label: "Soon", pts: 30 },
  routine: { label: "Routine", pts: 10 },
};

const AVAIL = { any: "Home all day", am: "Mornings only", pm: "Afternoons only" };

const REASONS = ["Patient unwell", "Admitted to hospital", "Patient asked to rebook", "Family can't be present"];

// The demo week: day 0 is "today", Monday 12 October, through Friday.
const DAYS = ["Mon 12 Oct", "Tue 13 Oct", "Wed 14 Oct", "Thu 15 Oct", "Fri 16 Oct"];
const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
/** How a text should refer to a day: "today", "tomorrow", or "on Wednesday 14 Oct". */
const dayPhrase = (day) => (day === 0 ? "today" : day === 1 ? "tomorrow" : `on ${DAY_NAMES[day]} ${DAYS[day].slice(4)}`);

const hm = (m) => String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0");
const district = (pc) => String(pc).trim().split(" ")[0].toUpperCase();
const first = (n) => String(n).split(" ")[0];

module.exports = { DAY_START, DAY_END, DAYS, DAY_NAMES, dayPhrase, TYPES, PRIO, AVAIL, REASONS, hm, district, first };
