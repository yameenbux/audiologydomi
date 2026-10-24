"use strict";
// Route planning. Pure functions with no database access: given one clinician's day, put the visits that
// haven't started in the order that drives least, and work out new times.
//
// Rules, so a planned day is one the office can send without phoning anyone first:
// - Visits already done, under way or set off for stay exactly where they are.
// - Morning visits stay in the morning and afternoon visits in the afternoon. Patients say which half of
//   the day suits them (carers, day centres), so the planner never swaps the two.
// - A visit with a time restriction (not before 14:00, only at 11:00: domain TW) is kept to it. A diary that
//   breaks one (the office has just recorded it) is re-planned to fit, even when that saves no driving.
// - Today, nothing is moved earlier than half an hour from now, so the patient has warning.
// - The day starts and ends at the clinician's home base, and the drive home counts.
const { DAY_START, DAY_END, twAllows, twLabel } = require("./domain");

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

/**
 * The order of `vs` from `from` (and on to `to`) that drives least, among the orders `ok` accepts (every
 * patient's time restriction kept). null when no order it tries is acceptable.
 */
function bestOrder(from, vs, to, drive, ok = () => true) {
  if (vs.length <= 1) return ok(vs) ? vs.slice() : null;
  if (vs.length <= EXACT_MAX) {
    // Equal driving (the same loop the other way round, say): keep the order closest to how it was booked,
    // so fewer patients get a new time.
    const kept = (p) => p.reduce((n, v, i) => n + (v === vs[i] ? 1 : 0), 0);
    let best = null, cost = Infinity;
    for (const p of permutations(vs)) {
      const c = legCost(from, p, to, drive);
      if ((c < cost || (c === cost && kept(p) > kept(best))) && ok(p)) { cost = c; best = p; }
    }
    return best;
  }
  // Nearest neighbour, then 2-opt: reverse any stretch that makes the route shorter, until nothing does. If the
  // nearest-neighbour order breaks a restriction, start from time order (restricted visits by their time) instead.
  const left = vs.slice(), nn = [];
  let at = from;
  while (left.length) { left.sort((a, b) => drive(at, a.pc) - drive(at, b.pc)); const v = left.shift(); nn.push(v); at = v.pc; }
  const byTime = vs.slice().sort((a, b) => anchor(a) - anchor(b));
  const seq = ok(nn) ? nn : ok(byTime) ? byTime : null;
  if (!seq) return null;
  for (let improved = true; improved;) {
    improved = false;
    for (let i = 0; i < seq.length - 1; i++) for (let j = i + 1; j < seq.length; j++) {
      const cand = seq.slice(0, i).concat(seq.slice(i, j + 1).reverse(), seq.slice(j + 1));
      if (legCost(from, cand, to, drive) < legCost(from, seq, to, drive) && ok(cand)) { seq.splice(0, seq.length, ...cand); improved = true; }
    }
  }
  return seq;
}
/** Where a visit sits in time order: its restricted time if it has one, otherwise when it's booked. */
const anchor = (v) => (v.tw && v.tw.at != null ? v.tw.at : v.start);
/** Which half of the day a visit belongs in: its restriction decides, otherwise where it's booked now. */
function halfOf(v) {
  const k = v.tw && v.tw.k;
  if (k === "am" || k === "pm") return k;
  if ((k === "after" || k === "fixed") && v.tw.at >= NOON) return "pm";
  if ((k === "before" || k === "fixed") && v.tw.at < NOON) return "am";
  return v.start < NOON ? "am" : "pm";
}

/**
 * @param {object} p
 * @param {string} p.base                where the clinician starts and ends the day
 * @param {object[]} p.visits            [{id, name, pc, dur, start, status}] the day's visits, not cancelled
 * @param {(a: string, b: string) => number} p.drive   minutes by car between two postcodes
 * @param {(a: string, b: string) => number} [p.miles]
 * @param {number} [p.now]               demo time in minutes, for today; omit for a later day
 * @param {number} [p.dayStart]          when the clinician starts that day (default 9:00)
 * @param {number} [p.dayEnd]            when they finish (default DAY_END, 17:30)
 * Returns the planned visits with their old and new times, and the driving before and after.
 */
function planDay({ base, visits, drive, miles = () => 0, now = null, dayStart = DAY_START, dayEnd = DAY_END }) {
  const byTime = visits.slice().sort((a, b) => a.start - b.start);
  const fixed = byTime.filter((v) => v.status !== "booked");
  const free = byTime.filter((v) => v.status === "booked");
  const am = free.filter((v) => halfOf(v) === "am"), pm = free.filter((v) => halfOf(v) === "pm");

  const lastFixed = fixed[fixed.length - 1];
  const from = lastFixed ? lastFixed.pc : base;
  let t0 = lastFixed ? lastFixed.start + lastFixed.dur : dayStart;
  if (now != null) t0 = Math.max(t0, now + NOTICE);
  const amSlots = am.map((v) => v.start).sort((a, b) => a - b), pmSlots = pm.map((v) => v.start).sort((a, b) => a - b);

  // Times for one half of the day in a given order. The day keeps its time slots where it can: the visits fill the
  // same start times in their new order, and a time only moves when the clinician couldn't get there by then, or a
  // patient can't be seen until later. Fewer patients get a new time that way. ok: every restriction is kept.
  const timeHalf = (seq, half, slots, t, at) => {
    const rows = [];
    let ok = true;
    seq.forEach((v, i) => {
      const d = drive(at, v.pc);
      // The first visit of the day can start when the working day does: the drive from home happens before it.
      const reach = at === base && !lastFixed && t === dayStart ? dayStart : t + d;
      let start = ROUND5(Math.max(reach, half === "pm" ? NOON : dayStart, slots[i] == null ? 0 : slots[i]));
      if (now != null) start = Math.max(start, ROUND5(now + NOTICE));
      if (v.tw && (v.tw.k === "after" || v.tw.k === "fixed")) start = Math.max(start, v.tw.at);
      if (!twAllows(v.tw, start)) ok = false;
      rows.push({ v, start, drive: d });
      t = start + v.dur; at = v.pc;
    });
    return { rows, ok, t, at, late: t > dayEnd };
  };
  // Best: every restriction kept and finished by the end of the day. Next best: restrictions kept. Last: time order.
  const pick = (vs, from_, to, run) => bestOrder(from_, vs, to, drive, (s) => { const r = run(s); return r.ok && !r.late; })
    || bestOrder(from_, vs, to, drive, (s) => run(s).ok) || vs.slice().sort((a, b) => anchor(a) - anchor(b));
  const amOrder = pick(am, from, pm.length ? null : base, (s) => timeHalf(s, "am", amSlots, t0, from));
  const amRun = timeHalf(amOrder, "am", amSlots, t0, from);
  const pmOrder = pick(pm, amRun.at, base, (s) => timeHalf(s, "pm", pmSlots, amRun.t, amRun.at));
  const pmRun = timeHalf(pmOrder, "pm", pmSlots, amRun.t, amRun.at);

  const warnings = [];
  const planned = [];
  const end = `${String(Math.floor(dayEnd / 60)).padStart(2, "0")}:${String(dayEnd % 60).padStart(2, "0")}`;
  for (const [half, run] of [["am", amRun], ["pm", pmRun]]) for (const { v, start, drive: d } of run.rows) {
    if (half === "am" && start >= NOON && !v.tw) warnings.push(`${v.name} would start after midday`);
    if (!twAllows(v.tw, start)) warnings.push(`${v.name} can't be fitted to "${twLabel(v.tw)}" on this day: move them to another day`);
    if (start + v.dur > dayEnd) warnings.push(`${v.name} would finish after ${end}`);
    planned.push({ id: v.id, name: v.name, pc: v.pc, dur: v.dur, from: v.start, start, drive: d, moved: start !== v.start, tw: v.tw ? twLabel(v.tw) : null });
  }
  // Visits booked at a time their patient can't do: the plan puts them right even if it saves no driving.
  const broken = free.filter((v) => !twAllows(v.tw, v.start));

  const totals = (seq) => {
    const stops = fixed.concat(seq);
    let mins = 0, dist = 0, a = base;
    for (const v of stops) { mins += drive(a, v.pc); dist += miles(a, v.pc); a = v.pc; }
    if (stops.length) { mins += drive(a, base); dist += miles(a, base); }
    return { driveMin: mins, miles: Math.round(dist * 10) / 10 };
  };
  const before = totals(free), after = totals(amOrder.concat(pmOrder));
  // Only worth changing if it actually saves driving, or puts right a time a patient can't do.
  const fixes = broken.filter((v) => { const p = planned.find((x) => x.id === v.id); return p && twAllows(v.tw, p.start); }).length;
  const better = before.driveMin - after.driveMin >= MIN_SAVING || fixes > 0;
  return {
    fixed: fixed.map((v) => ({ id: v.id, name: v.name, start: v.start, status: v.status })),
    planned: better ? planned : free.map((v) => ({ id: v.id, name: v.name, pc: v.pc, dur: v.dur, from: v.start, start: v.start, moved: false })),
    before, after: better ? after : before,
    savedMin: better ? Math.max(0, before.driveMin - after.driveMin) : 0, extraMin: better ? Math.max(0, after.driveMin - before.driveMin) : 0, fixes, savedMiles: better ? Math.round((before.miles - after.miles) * 10) / 10 : 0,
    changed: better ? planned.filter((p) => p.moved).length : 0,
    warnings: better ? warnings : broken.map((v) => `${v.name} is booked outside "${twLabel(v.tw)}" and can't be fitted on this day: move them to another day`),
  };
}

module.exports = { planDay, bestOrder };
