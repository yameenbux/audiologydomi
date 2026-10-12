"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { suggestSlots } = require("../server/refill");
const { driveMinutes } = require("../server/travel");

const clinicians = [{ id: "c1", first: "Amira", optom: true, patch: ["LS6", "LS16", "LS17"], near: ["LS7"] }];
// Amira: 11:00–11:30 in LS6, then 13:30–14:30 in LS16.
const appts = [
  { id: "a", clinicianId: "c1", start: 660, type: "dispense", pc: "LS6", name: "Peter" },
  { id: "b", clinicianId: "c1", start: 810, type: "sight", pc: "LS16", name: "Ken" },
];

test("drive estimates are symmetric, short within a district and unknown outside the map", () => {
  assert.strictEqual(driveMinutes("LS6", "LS17"), driveMinutes("LS17", "LS6"));
  assert.ok(driveMinutes("LS6", "LS6") < driveMinutes("LS6", "LS17"));
  assert.strictEqual(driveMinutes("M1", "LS6"), null);
});

test("a visit only fits where the drive in and the drive on both fit", () => {
  const slots = suggestSlots({ pc: "LS17", type: "follow", clinicians, appts, now: 620, days: 1 });
  for (const s of slots) {
    const prevEnd = s.prev === "Peter" ? 690 : s.prev === "Ken" ? 870 : 540;
    assert.ok(s.start >= prevEnd + s.driveIn, `${s.label} leaves time to drive from ${s.prev}`);
    if (s.next === "Ken") assert.ok(s.end + s.driveOut <= 810, `${s.label} leaves time to reach Ken`);
  }
  assert.ok(slots.some((s) => s.prev === "Peter" && s.next === "Ken"), "fits the lunchtime gap");
  assert.ok(slots.every((s) => s.start >= 650), "gives the patient at least 30 minutes' notice");
});

test("options are ranked by the extra driving they add", () => {
  const slots = suggestSlots({ pc: "LS16", type: "follow", clinicians, appts, now: 620 });
  const top = slots[0];
  assert.ok(slots.every((s) => s.extraDrive >= top.extraDrive || s.area !== top.area));
  assert.match(top.why[0], /extra driving/);
});

test("mornings-only and afternoons-only are respected; far-away patients get no slots", () => {
  assert.ok(suggestSlots({ pc: "LS17", type: "follow", avail: "am", clinicians, appts, now: 620 }).every((s) => s.start < 720));
  assert.ok(suggestSlots({ pc: "LS17", type: "follow", avail: "pm", clinicians, appts, now: 620 }).every((s) => s.start >= 720));
  assert.deepStrictEqual(suggestSlots({ pc: "LS27", type: "follow", clinicians, appts, now: 620 }), []);
});

test("later days are searched too, without same-day notice, and sooner wins on equal driving", () => {
  const slots = suggestSlots({ pc: "LS17", type: "follow", clinicians, appts, now: 620 });
  assert.ok(slots.some((s) => s.day > 0), "an empty Tuesday offers slots");
  assert.ok(slots.some((s) => s.day === 1 && s.start < 600 && s.start >= 540 + s.driveIn), "first thing on a later day, after the drive from the start of the round");
  const equal = slots.filter((s) => s.extraDrive === slots[0].extraDrive && s.area === slots[0].area);
  assert.ok(equal.every((s, i) => i === 0 || s.day >= equal[0].day), "ties go to the sooner day");
});

test("urgent patients are pulled towards sooner days; routine ones towards less driving", () => {
  // A Thursday visit next door in LS17 makes Thursday the cheapest drive.
  const week = [...appts, { id: "t", clinicianId: "c1", day: 3, start: 600, type: "sight", pc: "LS17", name: "Doreen" }];
  const routine = suggestSlots({ pc: "LS17", type: "follow", clinicians, appts: week, now: 620, prio: "routine" });
  const urgent = suggestSlots({ pc: "LS17", type: "follow", clinicians, appts: week, now: 620, prio: "urgent" });
  assert.ok(urgent[0].day <= routine[0].day);
  assert.strictEqual(urgent[0].day, 0, "urgent goes today if it fits");
});

test("an NHS sight test is only offered 48 hours ahead, and only with an optometrist", () => {
  const tom = { id: "c2", first: "Tom", optom: false, patch: ["LS17"], near: [] };
  const slots = suggestSlots({ pc: "LS17", type: "sight", clinicians: [...clinicians, tom], appts, now: 620 });
  assert.ok(slots.length > 0);
  assert.ok(slots.every((s) => s.day * 1440 + s.start >= 620 + 48 * 60), "nothing inside PCSE's 48 hours");
  assert.ok(slots.every((s) => s.clinicianId === "c1"), "the dispensing optician can't test eyes");
  assert.ok(suggestSlots({ pc: "LS17", type: "repair", clinicians: [tom], appts: [], now: 620 }).length > 0, "but can do repairs");
});
