"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { suggestSlots } = require("../server/refill");
const { driveMinutes } = require("../server/travel");

const clinicians = [{ id: "c1", first: "Amira", patch: ["LS6", "LS16", "LS17"], near: ["LS7"] }];
// Amira: 11:00–12:15 in LS6, then 13:30–14:30 in LS16.
const appts = [
  { id: "a", clinicianId: "c1", start: 660, type: "fit", pc: "LS6", name: "Peter" },
  { id: "b", clinicianId: "c1", start: 810, type: "assess", pc: "LS16", name: "Ken" },
];

test("drive estimates are symmetric, short within a district and unknown outside the map", () => {
  assert.strictEqual(driveMinutes("LS6", "LS17"), driveMinutes("LS17", "LS6"));
  assert.ok(driveMinutes("LS6", "LS6") < driveMinutes("LS6", "LS17"));
  assert.strictEqual(driveMinutes("M1", "LS6"), null);
});

test("a visit only fits where the drive in and the drive on both fit", () => {
  const slots = suggestSlots({ pc: "LS17", type: "review", clinicians, appts, now: 620 });
  for (const s of slots) {
    const prevEnd = s.prev === "Peter" ? 735 : s.prev === "Ken" ? 870 : 540;
    assert.ok(s.start >= prevEnd + s.driveIn, `${s.label} leaves time to drive from ${s.prev}`);
    if (s.next === "Ken") assert.ok(s.end + s.driveOut <= 810, `${s.label} leaves time to reach Ken`);
  }
  assert.ok(slots.some((s) => s.prev === "Peter" && s.next === "Ken"), "fits the lunchtime gap");
  assert.ok(slots.every((s) => s.start >= 650), "gives the patient at least 30 minutes' notice");
});

test("options are ranked by the extra driving they add", () => {
  const slots = suggestSlots({ pc: "LS16", type: "review", clinicians, appts, now: 620 });
  const top = slots[0];
  assert.ok(slots.every((s) => s.extraDrive >= top.extraDrive || s.area !== top.area));
  assert.match(top.why[0], /extra driving/);
});

test("mornings-only and afternoons-only are respected; far-away patients get no slots", () => {
  assert.ok(suggestSlots({ pc: "LS17", type: "review", avail: "am", clinicians, appts, now: 620 }).every((s) => s.start < 720));
  assert.ok(suggestSlots({ pc: "LS17", type: "review", avail: "pm", clinicians, appts, now: 620 }).every((s) => s.start >= 720));
  assert.deepStrictEqual(suggestSlots({ pc: "LS27", type: "review", clinicians, appts, now: 620 }), []);
});
