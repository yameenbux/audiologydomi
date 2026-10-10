"use strict";
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
