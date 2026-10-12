"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { freeWindow, rankCandidates, parseReply, suggestSlots } = require("../server/refill");

const clinician = { id: "c1", first: "Amira", optom: true, patch: ["LS6", "LS16"], near: ["LS7"] };
const patientsById = {
  p1: { id: "p1", name: "Urgent Far", pc: "LS27" },
  p2: { id: "p2", name: "Soon Local", pc: "LS6" },
  p3: { id: "p3", name: "Routine Near", pc: "LS7" },
  p4: { id: "p4", name: "Needs Notice", pc: "LS6" },
  p5: { id: "p5", name: "Too Long", pc: "LS16" },
  p6: { id: "p6", name: "Afternoons", pc: "LS16" },
  p7: { id: "p7", name: "NHS Test", pc: "LS6" },
  p8: { id: "p8", name: "Calls Only", pc: "LS6", contact: "Call" },
};
const W = (id, patientId, o) => Object.assign({ id, patientId, type: "repair", prio: "routine", days: 0, avail: "any", shortNotice: true, prefClinicianId: null, status: "waiting" }, o);
const waitlist = [
  W("w1", "p1", { prio: "urgent" }),
  W("w2", "p2", { prio: "soon", days: 10 }),
  W("w3", "p3", { days: 30 }),
  W("w4", "p4", { prio: "urgent", shortNotice: false }),
  W("w5", "p5", { type: "sight" }),
  W("w6", "p6", { avail: "pm" }),
  W("w7", "p7", { type: "follow", prio: "urgent" }),
  W("w8", "p8", { prio: "urgent" }),
];
const slot = { id: "a1", start: 11 * 60, drive: 10 };
const dayAppts = [slot, { id: "a2", start: 12 * 60, drive: 10 }];

test("free window runs to the next visit minus its drive", () => {
  assert.strictEqual(freeWindow(slot, dayAppts), 50);
  assert.strictEqual(freeWindow(slot, [slot]), 6 * 60);
});

test("hard rules exclude unsuitable patients with a reason", () => {
  const { candidates } = rankCandidates({ slot, clinician, dayAppts, waitlist, patientsById });
  const byId = Object.fromEntries(candidates.map((c) => [c.waitlistId, c]));
  assert.match(byId.w1.reason, /outside/);
  assert.match(byId.w4.reason, /24h/);
  assert.match(byId.w5.reason, /Needs 60 min/);
  assert.match(byId.w6.reason, /Afternoons/);
});

test("patients who asked to be phoned stay suitable, flagged for the office to ring rather than text", () => {
  const { candidates } = rankCandidates({ slot, clinician, dayAppts, waitlist, patientsById });
  const w8 = candidates.find((c) => c.waitlistId === "w8");
  assert.ok(w8.ok && w8.byPhone);
  assert.ok(w8.why.some((w) => /phone them/.test(w)));
  assert.ok(!candidates.find((c) => c.waitlistId === "w2").byPhone);
});

test("an NHS sight test is only offered with 48 hours' notice for PCSE", () => {
  const roomy = [slot];
  const nhs = [W("n1", "p7", { type: "sight", prio: "urgent" })];
  const today = rankCandidates({ slot, clinician, dayAppts: roomy, waitlist: nhs, patientsById, leadMin: 40 }).candidates[0];
  assert.ok(!today.ok);
  assert.match(today.reason, /needs 48h notice/);
  const wed = rankCandidates({ slot, clinician, dayAppts: roomy, waitlist: nhs, patientsById, leadMin: 49 * 60, sameDay: false }).candidates[0];
  assert.ok(wed.ok);
  assert.ok(wed.why.includes("PCSE notice to lodge if booked"));
});

test("a dispensing optician isn't offered eye examinations", () => {
  const tom = { ...clinician, id: "c2", first: "Tom", optom: false };
  const { candidates } = rankCandidates({ slot, clinician: tom, dayAppts, waitlist, patientsById });
  assert.match(candidates.find((c) => c.waitlistId === "w7").reason, /Needs an optometrist/);
  assert.ok(candidates.find((c) => c.waitlistId === "w2").ok, "repairs are fine");
});

test("eligible patients are ranked by priority, locality and wait", () => {
  const { candidates } = rankCandidates({ slot, clinician, dayAppts, waitlist, patientsById });
  const texted = candidates.filter((c) => c.ok && !c.byPhone).map((c) => c.waitlistId);
  assert.deepStrictEqual(texted, ["w7", "w2", "w3"]);
  assert.ok(candidates[0].ok, "eligible candidates sort first");
});

test("declined and booked entries are skipped", () => {
  const { candidates } = rankCandidates({ slot, clinician, dayAppts, waitlist, patientsById, declined: ["w2"] });
  assert.strictEqual(candidates.filter((c) => c.ok)[0].waitlistId, "w7");
  assert.ok(!candidates.some((c) => c.waitlistId === "w2"));
});

test("reply parsing", () => {
  assert.strictEqual(parseReply("YES please"), "yes");
  assert.strictEqual(parseReply(" y "), "yes");
  assert.strictEqual(parseReply("No thank you"), "no");
  assert.strictEqual(parseReply("What time?"), "unknown");
});

const { planOffer } = require("../server/refill");

test("a visit 40 min away is offered to the top three at once", () => {
  const p = planOffer({ leadMin: 40, drive: 11, offerMinutes: 20, eligible: 5 });
  assert.strictEqual(p.mode, "parallel");
  assert.strictEqual(p.count, 3);
  assert.strictEqual(p.windowMin, 9); // 19 min of slack, halved
});

test("a visit hours away is offered one at a time with room for three rounds", () => {
  const p = planOffer({ leadMin: 190, drive: 16, offerMinutes: 20, eligible: 5 });
  assert.deepStrictEqual([p.mode, p.count, p.windowMin], ["single", 1, 20]);
  assert.strictEqual(planOffer({ leadMin: 70, drive: 0, offerMinutes: 20, eligible: 2 }).windowMin, 20);
});

test("too close to the visit, or nobody suitable, means no offer", () => {
  assert.strictEqual(planOffer({ leadMin: 15, drive: 11, offerMinutes: 20, eligible: 3 }).mode, "too-late");
  assert.strictEqual(planOffer({ leadMin: 300, drive: 10, offerMinutes: 20, eligible: 0 }).mode, "none");
});

test("cancellation texts are recognised", () => {
  assert.strictEqual(parseReply("CANCEL"), "cancel");
  assert.strictEqual(parseReply("Please cancel my visit"), "cancel");
  assert.strictEqual(parseReply("can't make it today"), "no");
});

test("working hours: the free window stops at the end of the clinician's day, and a day off gets no slots", () => {
  const late = { id: "a9", start: 14 * 60, drive: 0, day: 1 };
  assert.strictEqual(freeWindow(late, [late], 15 * 60), 60);
  const short = { ...clinician, hours: [[540, 1020], [540, 900], null, [540, 1020], [540, 1020]] };
  const early = { ...clinician, hours: [[540, 1020], [540, 885], [540, 1020], [540, 1020], [540, 1020]] }; // finishes 14:45 on Tuesday
  const { candidates } = rankCandidates({ slot: late, clinician: early, dayAppts: [late], waitlist: [W("x", "p5", { type: "sight" })], patientsById });
  assert.match(candidates[0].reason, /Needs 60 min, slot is 45/);
  const slots = suggestSlots({ pc: "LS6 4AA", type: "repair", clinicians: [{ ...short, base: "LS6 4AA" }], appts: [], now: 600 });
  assert.ok(!slots.some((s) => s.day === 2), "nothing on their day off");
  assert.ok(slots.filter((s) => s.day === 1).every((s) => s.end <= 900), "nothing after they finish on Tuesday");
  assert.ok(slots.some((s) => s.day === 1), "but Tuesday morning is offered");
  assert.ok(!suggestSlots({ pc: "LS6 4AA", type: "repair", clinicians: [{ ...short, base: "LS6 4AA", active: false }], appts: [], now: 600 }).length, "nobody who has left");
});
