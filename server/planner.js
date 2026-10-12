"use strict";
// Route planning. Pure functions with no database access: given one clinician's day, put the visits that
// haven't started in the order that drives least, and work out new times.
//
// Rules, so a planned day is one the office can send without phoning anyone first:
// - Visits already done, under way or set off for stay exactly where they are.
// - Morning visits stay in the morning and afternoon visits in the afternoon. Patients say which half of
//   the day suits them (carers, day centres), so the planner never swaps the two.
// - Today, nothing is moved earlier than half an hour from now, so the patient has warning.
// - The day starts and ends at the clinician's home base, and the drive home counts.
const { DAY_START, DAY_END } = require("./domain");

const NOON = 12 * 60;
const ROUND5 = (m) => Math.ceil(m / 5) * 5;
const NOTICE = 30;
const MIN_SAVING = 10; // minutes: less than this isn't worth texting patients new times
const EXACT_MAX = 7; // up to 7 visits in a half-day: try every order (5,040). More: nearest neighbour, then 2-opt.

function permutations(a) {
  if (a.length <= 1) return [a.slice()];
  const out = [];
  a.forEach((x, i) => permutations(a.slice(0, i).concat(a.slice(i + 1))).forEach((p) => out.push([x, ...p])));
  return out;
}

/** Driving for a sequence of postcodes from `from`, optionally ending at `to`. */
const legCost = (from, seq, to, drive) => {
  let t = 0, at = from;
  for (const v of seq) { t += drive(at, v.pc); at = v.pc; }
  return to ? t + drive(at, to) : t;
};

/** The order of `vs` from `from` (and on to `to`) that drives least. */
function bestOrder(from, vs, to, drive) {
  if (vs.length <= 1) return vs.slice();
  if (vs.length <= EXACT_MAX) {
    // Equal driving (the same loop the other way round, say): keep the order closest to how it was booked,
    // so fewer patients get a new time.
    const kept = (p) => p.reduce((n, v, i) => n + (v === vs[i] ? 1 : 0), 0);
    let best = null, cost = Infinity;
    for (const p of permutations(vs)) { const c = legCost(from, p, to, drive); if (c < cost || (c === cost && kept(p) > kept(best))) { cost = c; best = p; } }
    return best;
  }
  // Nearest neighbour, then 2-opt: reverse any stretch that makes the route shorter, until nothing does.
  const left = vs.slice(), seq = [];
  let at = from;
  while (left.length) { left.sort((a, b) => drive(at, a.pc) - drive(at, b.pc)); const v = left.shift(); seq.push(v); at = v.pc; }
  for (let improved = true; improved;) {
    improved = false;
    for (let i = 0; i < seq.length - 1; i++) for (let j = i + 1; j < seq.length; j++) {
      const cand = seq.slice(0, i).concat(seq.slice(i, j + 1).reverse(), seq.slice(j + 1));
      if (legCost(from, cand, to, drive) < legCost(from, seq, to, drive)) { seq.splice(0, seq.length, ...cand); improved = true; }
    }
  }
  return seq;
}

/**
 * @param {object} p
 * @param {string} p.base                where the clinician starts and ends the day
 * @param {object[]} p.visits            [{id, name, pc, dur, start, status}] the day's visits, not cancelled
 * @param {(a: string, b: string) => number} p.drive   minutes by car between two postcodes
 * @param {(a: string, b: string) => number} [p.miles]
 * @param {number} [p.now]               demo time in minutes, for today; omit for a later day
 * Returns the planned visits with their old and new times, and the driving before and after.
 */
function planDay({ base, visits, drive, miles = () => 0, now = null }) {
  const byTime = visits.slice().sort((a, b) => a.start - b.start);
  const fixed = byTime.filter((v) => v.status !== "booked");
  const free = byTime.filter((v) => v.status === "booked");
  const am = free.filter((v) => v.start < NOON), pm = free.filter((v) => v.start >= NOON);

  const lastFixed = fixed[fixed.length - 1];
  const from = lastFixed ? lastFixed.pc : base;
  let t = lastFixed ? lastFixed.start + lastFixed.dur : DAY_START;
  if (now != null) t = Math.max(t, now + NOTICE);

  const amOrder = bestOrder(from, am, pm.length ? null : base, drive);
  const pmFrom = amOrder.length ? amOrder[amOrder.length - 1].pc : from;
  const pmOrder = bestOrder(pmFrom, pm, base, drive);

  const warnings = [];
  let at = from;
  const planned = [];
  // The day keeps its time slots where it can: the visits fill the same start times in their new order, and a
  // time only moves when the clinician couldn't get there by then. Fewer patients get a new time that way.
  for (const [half, seq, slots] of [["am", amOrder, am.map((v) => v.start).sort((a, b) => a - b)], ["pm", pmOrder, pm.map((v) => v.start).sort((a, b) => a - b)]]) {
    seq.forEach((v, i) => {
      const d = drive(at, v.pc);
      // The first visit of the day can start at 9:00: the drive from home happens before the working day.
      const reach = at === base && !lastFixed && t === DAY_START ? DAY_START : t + d;
      let start = ROUND5(Math.max(reach, half === "pm" ? NOON : DAY_START, slots[i]));
      if (now != null) start = Math.max(start, ROUND5(now + NOTICE));
      if (half === "am" && start >= NOON) warnings.push(`${v.name} would start after midday`);
      if (start + v.dur > DAY_END) warnings.push(`${v.name} would finish after ${Math.floor(DAY_END / 60)}:00`);
      planned.push({ id: v.id, name: v.name, pc: v.pc, dur: v.dur, from: v.start, start, drive: d, moved: start !== v.start });
      t = start + v.dur; at = v.pc;
    });
  }

  const totals = (seq) => {
    const stops = fixed.concat(seq);
    let mins = 0, dist = 0, a = base;
    for (const v of stops) { mins += drive(a, v.pc); dist += miles(a, v.pc); a = v.pc; }
    if (stops.length) { mins += drive(a, base); dist += miles(a, base); }
    return { driveMin: mins, miles: Math.round(dist * 10) / 10 };
  };
  const before = totals(free), after = totals(amOrder.concat(pmOrder));
  // Only worth changing if it actually saves driving.
  const better = before.driveMin - after.driveMin >= MIN_SAVING;
  return {
    fixed: fixed.map((v) => ({ id: v.id, name: v.name, start: v.start, status: v.status })),
    planned: better ? planned : free.map((v) => ({ id: v.id, name: v.name, pc: v.pc, dur: v.dur, from: v.start, start: v.start, moved: false })),
    before, after: better ? after : before,
    savedMin: better ? before.driveMin - after.driveMin : 0, savedMiles: better ? Math.round((before.miles - after.miles) * 10) / 10 : 0,
    changed: better ? planned.filter((p) => p.moved).length : 0,
    warnings: better ? warnings : [],
  };
}

module.exports = { planDay, bestOrder };
