"use strict";
// The pilot: what the practice measured before Domi (its baseline), the targets agreed at signing, and what Domi
// measures week by week from go-live. The success fee is due only if the targets are met, so every number here
// comes from the practice's own diary, or from what the office records itself; nothing is estimated.
const cal = require("./calendar");
const sandbox = require("./sandbox");
const { db } = require("./db");
const svc = require("./service");
const bus = require("./bus");

const all = (sql, ...a) => db.prepare(sql).all(...a);
const one = (sql, ...a) => db.prepare(sql).get(...a);

// What can be measured, and which way is better. `measured`: Domi works it out; otherwise the office enters it weekly
// (`entry` names what it types in). Miles come from the clinicians' mileage claims, the same source as the baseline:
// Domi's own planned-route miles are shown alongside for reference, never judged against the baseline.
const MEASURES = {
  milesPerVisit: { label: "Miles driven per visit", unit: "miles", better: "down", measured: false, entry: "miles", dp: 1 },
  unfilledPerWeek: { label: "Cancelled slots left empty, per week", unit: "slots", better: "down", measured: true, dp: 1 },
  officeHours: { label: "Office hours a week on scheduling and phoning round", unit: "hours", better: "down", measured: false, entry: "hours", dp: 1 },
  visitsPerWeek: { label: "Visits done per week", unit: "visits", better: "up", measured: true, dp: 0 },
};
const WEEKS = 13; // the pilot runs three months
const round = (v, dp) => (v == null ? null : Math.round(v * 10 ** dp) / 10 ** dp);

/** The pilot as saved in the practice's settings, with defaults. */
function config() {
  const p = svc.settings().pilot || {};
  return { start: p.start || null, baseline: p.baseline || {}, targets: Array.isArray(p.targets) ? p.targets : [], hours: p.hours || {}, miles: p.miles || {}, agreedBy: p.agreedBy || null };
}

/** Set the go-live date, the baseline and the targets. Only the office; changes are audited. */
function save(input, user) {
  return svc.tx(() => {
    const st = svc.settings(), cur = config(), next = { ...cur };
    if (input.start !== undefined) {
      if (input.start && !/^\d{4}-\d{2}-\d{2}$/.test(String(input.start))) throw new svc.HttpError(400, "Choose the go-live date.");
      next.start = input.start || null;
    }
    if (input.baseline !== undefined) {
      const b = {};
      for (const [k, v] of Object.entries(input.baseline || {})) {
        if (!MEASURES[k]) continue;
        if (v === "" || v == null) continue;
        const n = Number(v);
        if (!Number.isFinite(n) || n < 0 || n > 10000) throw new svc.HttpError(400, `Enter a number for "${MEASURES[k].label}".`);
        b[k] = n;
      }
      next.baseline = b;
    }
    if (input.targets !== undefined) {
      const t = [];
      for (const x of input.targets || []) {
        if (!MEASURES[x.key]) continue;
        const pct = Number(x.pct);
        if (!Number.isFinite(pct) || pct <= 0 || pct > 100) throw new svc.HttpError(400, `Enter the improvement for "${MEASURES[x.key].label}" as a percentage.`);
        if (next.baseline[x.key] == null) throw new svc.HttpError(400, `Enter the baseline for "${MEASURES[x.key].label}" before setting its target.`);
        t.push({ key: x.key, pct });
      }
      if (t.length > 4) throw new svc.HttpError(400, "Agree up to four targets.");
      next.targets = t;
    }
    if (input.agreedBy !== undefined) next.agreedBy = String(input.agreedBy || "").trim().slice(0, 80) || null;
    st.pilot = next;
    svc.audit(user.name, "pilot.update", "settings", "Pilot baseline or targets changed");
    bus.emit({ type: "settings.updated" });
    return report();
  });
}

// What the office types in each week: hours it spent scheduling (Domi can't see calls made outside it), and the total
// miles on that week's mileage claims.
const ENTRIES = { hours: { max: 168, word: "hours" }, miles: { max: 20000, word: "miles" } };

/** Save the office's figures for one pilot week. Blank clears one. */
function saveWeek(week, input, user) {
  return svc.tx(() => {
    const c = config(), w = Number(week), st = svc.settings(), next = { ...c };
    if (!c.start) throw new svc.HttpError(400, "Set the go-live date first.");
    if (!Number.isInteger(w) || w < 1 || w > WEEKS) throw new svc.HttpError(400, "Choose a pilot week.");
    const said = [];
    for (const [k, e] of Object.entries(ENTRIES)) {
      if (input[k] === undefined) continue;
      const v = input[k] === "" || input[k] == null ? null : Number(input[k]);
      if (v != null && (!Number.isFinite(v) || v < 0 || v > e.max)) throw new svc.HttpError(400, `Enter the ${e.word} as a number.`);
      next[k] = { ...c[k] };
      if (v == null) delete next[k][w]; else next[k][w] = v;
      said.push(v == null ? `${e.word} cleared` : `${v} ${e.word}`);
    }
    if (!said.length) throw new svc.HttpError(400, "Enter the hours or the miles.");
    st.pilot = next;
    svc.audit(user.name, "pilot.week", "settings", `Week ${w}: ${said.join(", ")}`);
    return { ok: true };
  });
}

/** Domi's planned route miles for one clinician's day, from the same road routing as the mileage report. */
async function milesFor(clinicianId, day) {
  const r = await svc.routeFor(clinicianId, day, null, { withPath: false });
  return { miles: r.totals.miles, visits: r.totals.visits };
}

/** Week by week since go-live: what Domi measured, what the office entered, and how it compares with the baseline. */
async function report() {
  const c = config();
  const out = { measures: MEASURES, config: c, weeks: [], targets: [], today: cal.iso(0) };
  if (!c.start) return out;
  const startDay = cal.dayOf(c.start);
  const clinicians = all("SELECT id FROM clinicians");
  for (let w = 1; w <= WEEKS; w++) {
    const from = startDay + (w - 1) * 7, to = from + 6;
    if (from > 0) break; // not started yet
    const inProgress = to >= 0;
    const lastDay = Math.min(to, 0);
    let miles = 0, routed = 0;
    for (let d = from; d <= lastDay; d++) {
      if (!cal.isOpen(d)) continue;
      for (const k of clinicians) { const m = await milesFor(k.id, d); miles += m.miles; routed += m.visits; }
    }
    // Visits that went ahead (not cancelled or missed) on days already reached.
    const visits = one("SELECT COUNT(*) AS n FROM appointments WHERE day BETWEEN ? AND ? AND status NOT IN ('cancelled','missed')", from, lastDay).n;
    const cancelled = all("SELECT id FROM appointments WHERE day BETWEEN ? AND ? AND status = 'cancelled'", from, to);
    const refilled = cancelled.filter((a) => one("SELECT 1 FROM appointments WHERE filled_from = ? AND status != 'cancelled'", a.id)).length;
    out.weeks.push({
      week: w, from: cal.iso(from), to: cal.iso(to), label: `${cal.label(from)} – ${cal.label(to)}`, inProgress,
      // Per visit from the mileage claims the office entered; Domi's planned miles alongside, for reference only.
      milesClaimed: c.miles[w] != null ? c.miles[w] : null, milesPerVisit: c.miles[w] != null && visits ? round(c.miles[w] / visits, 1) : null,
      plannedMiles: round(miles, 1), plannedPerVisit: routed ? round(miles / routed, 1) : null, visits,
      cancellations: cancelled.length, refilled, unfilledPerWeek: cancelled.length - refilled,
      officeHours: c.hours[w] != null ? c.hours[w] : null, visitsPerWeek: visits,
    });
  }
  // Each target is judged on the average of the last four complete weeks (fewer early on).
  const complete = out.weeks.filter((x) => !x.inProgress).slice(-4);
  for (const t of c.targets) {
    const m = MEASURES[t.key], base = c.baseline[t.key];
    const vals = complete.map((x) => x[t.key]).filter((v) => v != null);
    const now = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    const goal = m.better === "down" ? base * (1 - t.pct / 100) : base * (1 + t.pct / 100);
    const met = now == null ? null : m.better === "down" ? now <= goal : now >= goal;
    const change = now == null || !base ? null : Math.round(((now - base) / base) * 100);
    out.targets.push({ key: t.key, label: m.label, unit: m.unit, better: m.better, pct: t.pct, baseline: base, goal: round(goal, m.dp), now: round(now, m.dp), weeks: vals.length, change, met });
  }
  out.status = !c.targets.length ? "no-targets" : out.targets.some((t) => t.met == null) ? "measuring" : out.targets.every((t) => t.met) ? "met" : "not-met";
  out.weeksComplete = out.weeks.filter((x) => !x.inProgress).length;
  return out;
}

module.exports = { report, save, saveWeek, MEASURES, WEEKS };
