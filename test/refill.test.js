"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { freeWindow, rankCandidates, parseReply } = require("../server/refill");

const clinician = { id: "c1", first: "Amira", patch: ["LS6", "LS16"], near: ["LS7"] };
const patientsById = {
  p1: { id: "p1", name: "Urgent Far", pc: "LS27" },
  p2: { id: "p2", name: "Soon Local", pc: "LS6" },
  p3: { id: "p3", name: "Routine Near", pc: "LS7" },
  p4: { id: "p4", name: "Needs Notice", pc: "LS6" },
  p5: { id: "p5", name: "Too Long", pc: "LS16" },
  p6: { id: "p6", name: "Afternoons", pc: "LS16" },
};
const W = (id, patientId, o) => Object.assign({ id, patientId, type: "wax", prio: "routine", days: 0, avail: "any", shortNotice: true, prefClinicianId: null, status: "waiting" }, o);
const waitlist = [
  W("w1", "p1", { prio: "urgent" }),
  W("w2", "p2", { prio: "soon", days: 10 }),
  W("w3", "p3", { days: 30 }),
  W("w4", "p4", { prio: "urgent", shortNotice: false }),
  W("w5", "p5", { type: "fit" }),
  W("w6", "p6", { avail: "pm" }),
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
  assert.match(byId.w5.reason, /Needs 75 min/);
  assert.match(byId.w6.reason, /Afternoons/);
});

test("eligible patients are ranked by priority, locality and wait", () => {
  const { candidates } = rankCandidates({ slot, clinician, dayAppts, waitlist, patientsById });
  const ok = candidates.filter((c) => c.ok).map((c) => c.waitlistId);
  assert.deepStrictEqual(ok, ["w2", "w3"]);
  assert.ok(candidates[0].ok, "eligible candidates sort first");
});

test("declined and booked entries are skipped", () => {
  const { candidates } = rankCandidates({ slot, clinician, dayAppts, waitlist, patientsById, declined: ["w2"] });
  assert.strictEqual(candidates.filter((c) => c.ok)[0].waitlistId, "w3");
});

test("reply parsing", () => {
  assert.strictEqual(parseReply("YES please"), "yes");
  assert.strictEqual(parseReply(" y "), "yes");
  assert.strictEqual(parseReply("No thank you"), "no");
  assert.strictEqual(parseReply("What time?"), "unknown");
});
