"use strict";
process.env.ROUTING_PROVIDER = "estimate";
const test = require("node:test");
const assert = require("node:assert");
const { planDay } = require("../server/planner");

// Places on a grid; the drive between two is 10 minutes per unit of straight-line distance.
const XY = { H: [0, 0], A: [1, 0], B: [2, 0], C: [2, 2], D: [0, 3], E: [5, 1] };
const drive = (a, b) => Math.round(Math.hypot(XY[a][0] - XY[b][0], XY[a][1] - XY[b][1]) * 10);
const V = (id, pc, start, o = {}) => ({ id, name: id, pc, dur: 30, start, status: "booked", ...o });

test("visits are re-ordered to drive least, keeping the day's time slots", () => {
  // Booked as C, A, B: out to C, back to A, then B, then home. The short loop is C, B, A (or A, B, C, the
  // same loop the other way round); C, B, A keeps C first, as booked, so it's the one chosen.
  const p = planDay({ base: "H", visits: [V("c", "C", 540), V("a", "A", 600), V("b", "B", 660)], drive });
  assert.deepStrictEqual(p.planned.map((x) => x.id), ["c", "b", "a"]);
  assert.deepStrictEqual(p.planned.map((x) => x.start), [540, 600, 660], "the same slots, in the new order");
  assert.strictEqual(p.before.driveMin, 28 + 22 + 10 + 20);
  assert.strictEqual(p.after.driveMin, 28 + 20 + 10 + 10);
  assert.strictEqual(p.savedMin, 12);
  assert.strictEqual(p.changed, 2, "c keeps its time, so only two patients get a new one");
});

test("mornings stay mornings and afternoons stay afternoons", () => {
  const p = planDay({ base: "H", visits: [V("pmA", "A", 800), V("amE", "E", 540), V("amB", "B", 600), V("pmD", "D", 860)], drive });
  const byId = Object.fromEntries(p.planned.map((x) => [x.id, x]));
  assert.ok(byId.amE.start < 720 && byId.amB.start < 720);
  assert.ok(byId.pmA.start >= 720 && byId.pmD.start >= 720);
});

test("visits under way stay put; today nothing moves inside half an hour", () => {
  const visits = [V("done", "A", 540, { status: "done" }), V("live", "B", 600, { status: "live" }), V("x", "E", 660), V("y", "C", 690), V("z", "D", 1500 - 800)];
  const p = planDay({ base: "H", visits, drive, now: 620 });
  assert.deepStrictEqual(p.fixed.map((f) => f.id), ["done", "live"]);
  assert.ok(p.after.driveMin <= p.before.driveMin);
  assert.ok(p.planned.every((x) => x.start >= 650));
});

test("a small saving isn't worth texting anyone: the day is left as it is", () => {
  const near = (a, b) => (a === b ? 0 : { "A|B": 6, "B|A": 6 }[a + "|" + b] || 5);
  const p = planDay({ base: "H", visits: [V("a", "A", 540), V("b", "B", 600)], drive: near });
  assert.strictEqual(p.changed, 0);
  assert.strictEqual(p.savedMin, 0);
});

test("problems are flagged: a morning visit pushed past midday, a day running past 17:00", () => {
  // Morning visits booked far apart, in a poor order: the better order still can't fit before noon.
  const slow = (a, b) => drive(a, b) * 6;
  const p = planDay({ base: "H", visits: [V("e", "E", 540), V("a", "A", 600), V("d", "D", 660), V("c", "C", 900)], drive: slow });
  assert.ok(p.savedMin > 0);
  assert.ok(p.warnings.some((w) => /after midday|after 17:00/.test(w)), p.warnings.join("; "));
});
