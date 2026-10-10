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

const hm = (m) => String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0");
const district = (pc) => String(pc).trim().split(" ")[0].toUpperCase();
const first = (n) => String(n).split(" ")[0];

module.exports = { DAY_START, DAY_END, TYPES, PRIO, AVAIL, REASONS, hm, district, first };
