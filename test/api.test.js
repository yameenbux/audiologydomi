"use strict";
process.env.ROUTING_PROVIDER = "estimate"; // the diary tests must not depend on a third-party router
// End-to-end API tests against the real HTTP server on a random port.
const test = require("node:test");
const assert = require("node:assert");
const { start, server } = require("../server/index");

let base;
test.before(async () => { const s = await start(0); base = `http://127.0.0.1:${s.address().port}`; });
test.after(() => server.close());

async function call(method, path, token, body) {
  const res = await fetch(base + path, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json() };
}
const login = async (userId, sandbox) => (await call("POST", "/api/login", null, { userId, sandbox })).data;
const state = async (t) => (await call("GET", "/api/state", t)).data;

test("a cancellation 40 minutes out offers the top three at once; first YES wins", async () => {
  const office = await login("u-admin");
  const r = (await call("POST", "/api/appointments/a3/cancel", office.token, { reason: "Patient unwell" })).data;
  assert.strictEqual(r.outcome, "offered");
  assert.strictEqual(r.plan.mode, "parallel");
  assert.deepStrictEqual(r.offers.map((o) => o.name), ["Gerald Wray", "Margaret Holt", "Sylvia Moon"]);
  assert.match(r.offers[0].body, /first person to reply YES/);

  const no = (await call("POST", "/api/demo/sms", office.token, { patientId: "p16", body: "No thanks" })).data;
  assert.strictEqual(no.action, "declined");
  assert.strictEqual(no.remaining, 2, "the others are still being asked");

  const yes = (await call("POST", "/api/demo/sms", office.token, { patientId: "p5", body: "Yes please" })).data;
  assert.strictEqual(yes.action, "accepted");

  const s = await state(office.token);
  const filled = s.appts.find((a) => a.moved);
  assert.strictEqual(filled.patientId, "p5");
  assert.ok(s.messages.some((m) => m.name === "Sylvia Moon" && /just been taken/.test(m.body)), "Sylvia is told it's gone");
  assert.strictEqual(s.waitlist.find((w) => w.patientId === "p13").status, "waiting", "Sylvia keeps her place");
  assert.strictEqual(s.metrics.refilled, 1);
  assert.strictEqual(s.metrics.recovered, s.settings.fee);
  assert.strictEqual(s.metrics.fillRate, 100);

  const late = (await call("POST", "/api/demo/sms", office.token, { patientId: "p13", body: "YES" })).data;
  assert.notStrictEqual(late.action, "accepted", "a late YES can't double-book");
});

test("a patient texting CANCEL cancels their visit and starts the refill", async () => {
  const office = await login("u-admin");
  const r = (await call("POST", "/api/demo/sms", office.token, { patientId: "p4", body: "CANCEL" })).data;
  assert.strictEqual(r.action, "cancelled");
  assert.strictEqual(r.refill.cancelled.byText, true);
  assert.strictEqual(r.refill.plan.mode, "single", "13:30 is hours away, so one person at a time");
  const s = await state(office.token);
  assert.strictEqual(s.appts.find((a) => a.id === "a4").status, "cancelled");
  assert.ok(s.messages.some((m) => m.name === "Ken Ollerton" && /we've cancelled/.test(m.body)));
});

test("each demo is private; phone and laptop share one by code", async () => {
  const a = await login("u-admin");
  const b = await login("u-admin");
  assert.notStrictEqual(a.sandbox, b.sandbox);
  await call("POST", "/api/appointments/a3/cancel", a.token, { reason: "Patient unwell" });
  assert.strictEqual((await state(b.token)).appts.find((x) => x.id === "a3").status, "booked", "B is unaffected");

  const phone = await login("u-c1", a.sandbox);
  assert.strictEqual(phone.sandbox, a.sandbox);
  const ps = await state(phone.token);
  assert.ok(ps.messages.some((m) => /cancelled/.test(m.body)), "Amira's phone sees the office's change");
  assert.strictEqual((await call("POST", "/api/login", null, { userId: "u-c1", sandbox: "NOPE99" })).status, 404);
});

test("clinicians can't play the patient or reach office endpoints", async () => {
  const office = await login("u-admin");
  const amira = await login("u-c1", office.sandbox);
  assert.strictEqual((await call("POST", "/api/demo/sms", amira.token, { patientId: "p5", body: "YES" })).status, 403);
  assert.strictEqual((await call("POST", "/api/admin/reset", amira.token)).status, 403);
  assert.strictEqual((await call("GET", "/api/patients/p7", amira.token)).status, 403, "Tom's patient");
});

test("the public SMS webhook is closed in demo mode and rejects unsigned requests", async () => {
  const r = await fetch(base + "/api/sms/inbound", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "From=07700900533&Body=YES" });
  assert.strictEqual(r.status, 404);
});

test("opening a record is audited; background refreshes are not", async () => {
  const office = await login("u-admin");
  await call("GET", "/api/patients/p5", office.token);
  await call("GET", "/api/patients/p5?background=1", office.token);
  await call("GET", "/api/patients/p5?background=1", office.token);
  const views = (await call("GET", "/api/debug/overview", office.token)).data.audit.filter((a) => a.action === "patient.view");
  assert.strictEqual(views.length, 1);
});

test("booking a new visit: ranked slots, booked into the round, can't be double-booked", async () => {
  const office = await login("u-admin");
  const found = (await call("POST", "/api/slots", office.token, { patientId: "p9", type: "review", avail: "pm" })).data;
  assert.ok(found.slots.length > 0, "Irene (LS17, afternoons) gets options");
  const pick = found.slots[0];
  assert.ok(pick.start >= 720);
  assert.strictEqual(pick.route, "road", "the sample patients' full postcodes are routed by road");
  const booked = await call("POST", "/api/bookings", office.token, { patientId: "p9", type: "review", avail: "pm", clinicianId: pick.clinicianId, day: pick.day, start: pick.start });
  assert.strictEqual(booked.status, 200);
  const s = await state(office.token);
  const v = s.appts.find((a) => a.id === booked.data.appointmentId);
  assert.strictEqual(v.start, pick.start);
  assert.strictEqual(s.waitlist.find((w) => w.patientId === "p9").status, "booked", "taken off the waiting list");
  assert.ok(s.messages.some((m) => m.name === "Irene Battye" && /is booked (today|tomorrow|on \w+day)/.test(m.body)));
  const again = await call("POST", "/api/bookings", office.token, { patientId: "p4", type: "review", avail: "pm", clinicianId: pick.clinicianId, day: pick.day, start: pick.start });
  assert.strictEqual(again.status, 409, "the same gap can't be booked twice");
});

test("booking a brand-new patient needs a postcode we can route to", async () => {
  const office = await login("u-admin");
  const bad = await call("POST", "/api/slots", office.token, { patientId: "new", name: "Ruth Ingham", pc: "M1", type: "wax" });
  assert.strictEqual(bad.status, 400);
  const full = (await call("POST", "/api/slots", office.token, { patientId: "new", name: "Ruth Ingham", pc: "ls167sn", type: "wax" })).data;
  assert.strictEqual(full.patient.pc, "LS16 7SN", "postcodes are tidied up");
  const ok = (await call("POST", "/api/slots", office.token, { patientId: "new", name: "Ruth Ingham", pc: "LS16", addr: "3 Holt Lane", type: "wax" })).data;
  const pick = ok.slots[0];
  const b = (await call("POST", "/api/bookings", office.token, { patientId: "new", name: "Ruth Ingham", pc: "LS16", addr: "3 Holt Lane", type: "wax", clinicianId: pick.clinicianId, day: pick.day, start: pick.start })).data;
  assert.ok(b.patientId);
  assert.ok((await state(office.token)).patients.some((p) => p.name === "Ruth Ingham"));
  const amira = await login("u-c1", office.sandbox);
  assert.strictEqual((await call("POST", "/api/slots", amira.token, { patientId: "p9", type: "review" })).status, 403, "office only");
});

test("the week: future visits exist, can be booked into, and can't be started early", async () => {
  const office = await login("u-admin");
  const s = await state(office.token);
  for (let d = 1; d <= 4; d++) assert.ok(s.appts.some((a) => a.day === d), `visits on day ${d}`);
  const slots = (await call("POST", "/api/slots", office.token, { patientId: "p13", type: "review" })).data.slots;
  const later = slots.find((x) => x.day >= 2);
  assert.ok(later, "offers a slot later in the week");
  const r = (await call("POST", "/api/bookings", office.token, { patientId: "p13", type: "review", clinicianId: later.clinicianId, day: later.day, start: later.start })).data;
  const msg = (await state(office.token)).messages.find((m) => m.name === "Sylvia Moon" && /is booked/.test(m.body));
  assert.match(msg.body, /on (Wednesday|Thursday|Friday) 1\d Oct/, "the text names the day");
  const amira = await login("u-" + later.clinicianId, office.sandbox);
  const early = await call("POST", `/api/appointments/${r.appointmentId}/status`, amira.token, { status: "enroute" });
  assert.strictEqual(early.status, 409, "can't set off for a Wednesday visit on Monday");
});

test("cancelling a visit later in the week refills it one at a time, and 24h-notice patients qualify", async () => {
  const office = await login("u-admin");
  const s = await state(office.token);
  const future = s.appts.find((a) => a.day === 3 && a.clinicianId === "c3");
  const r = (await call("POST", `/api/appointments/${future.id}/cancel`, office.token, { reason: "Patient asked to rebook" })).data;
  assert.strictEqual(r.plan.mode, "single", "days away, so one person at a time");
  const edna = r.candidates.find((c) => c.patientId === "p11");
  assert.ok(!edna || edna.reason !== "Needs 24h notice", "needing 24h notice doesn't rule anyone out for Thursday");
  assert.match(r.offers[0].body, /on Thursday 15 Oct/);
});
