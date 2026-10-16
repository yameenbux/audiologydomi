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

test("confirmation calls: CC3 the day before, CC2 within a week with a window, CC1 for new bookings", async () => {
  const o = await office();
  const list = async () => (await call("GET", "/api/calls", o.token)).data;
  let L = await list();
  const st = (await call("GET", "/api/state", o.token)).data;
  const tomorrow = st.appts.filter((a) => a.day === 1 && a.status === "booked");
  assert.strictEqual(L.calls[3].length, tomorrow.length, "every visit tomorrow needs its CC3");
  assert.ok(L.calls[2].length > 0 && L.calls[2].every((x) => x.day > 1 && x.day <= 7 && x.window[1] - x.window[0] === 180));
  assert.ok(L.calls[2].every((x) => x.window[0] <= x.start && x.start < x.window[1]), "the planned time is inside the window");
  assert.deepStrictEqual(st.calls, { 1: L.calls[1].length, 2: L.calls[2].length, 3: L.calls[3].length });

  // A visit booked a month out needs a CC1, with the date only.
  const slot = (await call("POST", "/api/slots", o.token, { patientId: "p9", type: "repair", avail: "any", date: "2026-11-16" })).data.slots[0];
  await call("POST", "/api/bookings", o.token, { patientId: "p9", type: "repair", avail: "any", clinicianId: slot.clinicianId, day: slot.day, start: slot.start });
  L = await list();
  const cc1 = L.calls[1].find((x) => x.day === slot.day);
  assert.ok(cc1, "on the CC1 list");
  assert.match(cc1.say, /November/); assert.doesNotMatch(cc1.say, /\d\d:\d\d/, "date only");

  // No answer keeps it there; spoken to takes it off.
  const x = L.calls[3][0];
  assert.strictEqual((await call("POST", `/api/calls/${x.apptId}`, o.token, { stage: 3, outcome: "no-answer" })).status, 200);
  assert.strictEqual((await list()).calls[3].find((y) => y.apptId === x.apptId).tries, 1);
  assert.strictEqual((await call("POST", `/api/calls/${x.apptId}`, o.token, { stage: 3, outcome: "done" })).status, 200);
  assert.ok(!(await list()).calls[3].some((y) => y.apptId === x.apptId));

  // Text instead sends the same words; a phone-only patient can't be texted.
  const t = (await list()).calls[3].find((y) => y.canText);
  const before = (await call("GET", "/api/state", o.token)).data.messages.length;
  assert.strictEqual((await call("POST", `/api/calls/${t.apptId}`, o.token, { stage: 3, outcome: "texted" })).status, 200);
  const after = (await call("GET", "/api/state", o.token)).data;
  assert.strictEqual(after.messages.length, before + 1);
  assert.ok(after.messages.some((m) => m.body === t.text));
  const phoneOnly = (await list()).calls[2].concat((await list()).calls[3]).find((y) => !y.canText);
  if (phoneOnly) assert.strictEqual((await call("POST", `/api/calls/${phoneOnly.apptId}`, o.token, { stage: phoneOnly.stage, outcome: "texted" })).status, 409);

  // The day-before reminder skips visits already called or texted at CC3.
  const r = (await call("POST", "/api/reminders/send", o.token)).data;
  assert.strictEqual(r.sent, tomorrow.length - 2);
  // Clinicians don't see the office's call list.
  const amira = await signIn("amira@airevalleyeyecare.example", o.sandbox);
  assert.strictEqual((await call("GET", "/api/calls", amira.token)).status, 403);
});
