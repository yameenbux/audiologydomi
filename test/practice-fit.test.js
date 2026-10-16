"use strict";
process.env.ROUTING_PROVIDER = "estimate";
// Fitting Domi to how a practice works: its own visit lengths, confirmation calls, the recall line for NHS sight
// tests, where bookings come from and how likely they are to go ahead.
const test = require("node:test");
const assert = require("node:assert");
const { start, server } = require("../server/index");
const auth = require("../server/auth");

let base;
test.before(async () => { const s = await start(0); base = `http://127.0.0.1:${s.address().port}`; });
test.after(() => server.close());
async function call(method, path, cookie, body) {
  const res = await fetch(base + path, { method, headers: { "Content-Type": "application/json", "X-Domi": "1", ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json(), cookie: (res.headers.get("set-cookie") || "").split(";")[0] };
}
async function signIn(email, sandboxId) {
  if (!sandboxId) sandboxId = (await call("POST", "/api/demo/start")).data.sandbox;
  const pw = await call("POST", "/api/auth/password", null, { sandbox: sandboxId, email, password: auth.DEMO_PASSWORD });
  const code = (await call("GET", "/api/auth/demo-code?challenge=" + encodeURIComponent(pw.data.challenge))).data.code;
  const r = await call("POST", "/api/auth/code", null, { challenge: pw.data.challenge, code });
  return { token: r.cookie, sandbox: sandboxId, user: r.data.user, status: r.status };
}
const office = () => signIn("sarah@airevalleyeyecare.example");

test("visit lengths: the practice sets its own, and booking uses them", async () => {
  const o = await office();
  assert.strictEqual((await call("GET", "/api/state", o.token)).data.types.sight.dur, 60);
  for (const bad of [7, 200, 33]) assert.strictEqual((await call("PUT", "/api/settings", o.token, { durations: { sight: bad } })).status, 400, String(bad));
  const ok = await call("PUT", "/api/settings", o.token, { durations: { sight: 40, repair: 15 } });
  assert.strictEqual(ok.status, 200, JSON.stringify(ok.data));
  assert.deepStrictEqual(ok.data.changed, ["visit lengths"]);
  const st = (await call("GET", "/api/state", o.token)).data;
  assert.strictEqual(st.types.sight.dur, 40);
  assert.strictEqual(st.types.repair.dur, 15);
  // Another demo still has the defaults.
  const other = await office();
  assert.strictEqual((await call("GET", "/api/state", other.token)).data.types.sight.dur, 60);
  // A slot for a sight test is now 40 minutes long.
  const slots = (await call("POST", "/api/slots", o.token, { patientId: "p9", type: "sight", avail: "any", date: "2026-10-19" })).data.slots;
  assert.ok(slots.length && slots.every((s) => s.end - s.start === 40));
  // Making visits much longer would run booked visits into each other: refused, naming one.
  const long = await call("PUT", "/api/settings", o.token, { durations: { sight: 180, exam: 180, dispense: 180, repair: 180, follow: 180 } });
  assert.strictEqual(long.status, 409);
  assert.match(long.data.error, /runs? into the next one/);
});
