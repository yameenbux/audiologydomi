"use strict";
process.env.ROUTING_PROVIDER = "estimate";
// Sign-in and sessions, end to end against the real server.
const test = require("node:test");
const assert = require("node:assert");
const { start, server } = require("../server/index");
const { DEMO_PASSWORD, LOCK_AFTER } = require("../server/auth");

let base;
test.before(async () => { const s = await start(0); base = `http://127.0.0.1:${s.address().port}`; });
test.after(() => server.close());

async function call(method, path, cookie, body, headers = {}) {
  const res = await fetch(base + path, { method, headers: { "Content-Type": "application/json", "X-Domi": "1", ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json(), setCookie: res.headers.get("set-cookie") || "", cookie: (res.headers.get("set-cookie") || "").split(";")[0] };
}
const newDemo = async () => (await call("POST", "/api/demo/start")).data.sandbox;
const password = (sandbox, email, pw = DEMO_PASSWORD) => call("POST", "/api/auth/password", null, { sandbox, email, password: pw });
const demoCode = async (challenge) => (await call("GET", "/api/auth/demo-code?challenge=" + encodeURIComponent(challenge))).data.code;
async function signIn(sandbox, email = "sarah@airevalleyeyecare.example") {
  const pw = await password(sandbox, email);
  const code = await demoCode(pw.data.challenge);
  const r = await call("POST", "/api/auth/code", null, { challenge: pw.data.challenge, code });
  return { cookie: r.cookie, code, res: r };
}

test("signing in needs the password and then the code; the cookie is HttpOnly and SameSite", async () => {
  const sb = await newDemo();
  assert.strictEqual((await call("GET", "/api/state")).status, 401, "nothing without a session");
  const pw = await password(sb, "sarah@airevalleyeyecare.example");
  assert.ok(pw.data.challenge && !pw.setCookie, "a password alone doesn't sign you in");
  assert.strictEqual((await call("POST", "/api/auth/code", null, { challenge: pw.data.challenge, code: "000000" })).status, 401);
  const r = await call("POST", "/api/auth/code", null, { challenge: pw.data.challenge, code: await demoCode(pw.data.challenge) });
  assert.strictEqual(r.status, 200);
  assert.match(r.setCookie, /HttpOnly/); assert.match(r.setCookie, /SameSite=Lax/);
  assert.strictEqual((await call("GET", "/api/state", r.cookie)).data.user.name, "Sarah Lane");
});

test("behind HTTPS the cookie is Secure", async () => {
  const sb = await newDemo();
  const pw = await password(sb, "sarah@airevalleyeyecare.example");
  const r = await call("POST", "/api/auth/code", null, { challenge: pw.data.challenge, code: await demoCode(pw.data.challenge) }, { "X-Forwarded-Proto": "https" });
  assert.match(r.setCookie, /; Secure/);
});

test("wrong passwords lock the account; unknown emails get the same answer", async () => {
  const sb = await newDemo();
  const unknown = await password(sb, "nobody@airevalleyeyecare.example");
  const wrong = await password(sb, "amira@airevalleyeyecare.example", "guess");
  assert.strictEqual(unknown.status, 401); assert.strictEqual(wrong.status, 401);
  assert.strictEqual(unknown.data.error, wrong.data.error, "doesn't reveal which emails exist");
  for (let i = 1; i < LOCK_AFTER; i++) await password(sb, "amira@airevalleyeyecare.example", "guess" + i);
  const locked = await password(sb, "amira@airevalleyeyecare.example");
  assert.strictEqual(locked.status, 429, "even the right password is refused while locked");
  assert.match(locked.data.error, /locked/);
  assert.strictEqual((await password(sb, "tom@airevalleyeyecare.example")).status, 200, "other accounts are unaffected");
});

test("a code can't be used twice", async () => {
  const sb = await newDemo();
  const first = await signIn(sb);
  await call("POST", "/api/auth/logout", first.cookie);
  const pw = await password(sb, "sarah@airevalleyeyecare.example");
  const replay = await call("POST", "/api/auth/code", null, { challenge: pw.data.challenge, code: first.code });
  assert.strictEqual(replay.status, 401);
  const fresh = await demoCode(pw.data.challenge);
  assert.notStrictEqual(fresh, first.code, "the helper moves on to the next code");
  assert.strictEqual((await call("POST", "/api/auth/code", null, { challenge: pw.data.challenge, code: fresh })).status, 200);
});

test("signing out ends the session on the server", async () => {
  const { cookie } = await signIn(await newDemo());
  const out = await call("POST", "/api/auth/logout", cookie);
  assert.match(out.setCookie, /Max-Age=0/);
  assert.strictEqual((await call("GET", "/api/state", cookie)).status, 401, "the old cookie is dead, not just forgotten");
});

test("changes are refused without the app's header or from another site", async () => {
  const { cookie } = await signIn(await newDemo());
  assert.strictEqual((await call("POST", "/api/appointments/a3/cancel", cookie, {}, { "X-Domi": "" })).status, 403);
  assert.strictEqual((await call("POST", "/api/appointments/a3/cancel", cookie, {}, { Origin: "https://evil.example" })).status, 403);
});

test("the office can view as a clinician; clinicians can't switch; office-only actions stay office-only", async () => {
  const sb = await newDemo();
  const office = await signIn(sb);
  await call("POST", "/api/auth/view-as", office.cookie, { userId: "u-c1" });
  const s = (await call("GET", "/api/state", office.cookie)).data;
  assert.strictEqual(s.user.id, "u-c1"); assert.strictEqual(s.signedInAs.id, "u-admin");
  assert.strictEqual((await call("POST", "/api/admin/reset", office.cookie)).status, 403, "while viewing as Amira");
  await call("POST", "/api/auth/view-as", office.cookie, { userId: "u-admin" });
  assert.strictEqual((await call("GET", "/api/state", office.cookie)).data.user.id, "u-admin");
  const amira = await signIn(sb, "amira@airevalleyeyecare.example");
  assert.strictEqual((await call("POST", "/api/auth/view-as", amira.cookie, { userId: "u-admin" })).status, 403);
});

test("a phone link signs in once, and the office can sign the phone out remotely", async () => {
  const sb = await newDemo();
  const office = await signIn(sb);
  const { token } = (await call("POST", "/api/auth/pair", office.cookie, { userId: "u-c1" })).data;
  const phone = await call("POST", "/api/auth/pair/redeem", null, { token }, { "User-Agent": "Mozilla/5.0 (iPhone)" });
  assert.strictEqual(phone.data.user.name, "Amira Shah");
  assert.strictEqual((await call("POST", "/api/auth/pair/redeem", null, { token })).status, 401, "single use");
  assert.strictEqual((await call("POST", "/api/auth/pair", phone.cookie, { userId: "u-c2" })).status, 403, "clinicians can't make links");

  const list = (await call("GET", "/api/auth/sessions", office.cookie)).data;
  const p = list.find((x) => x.name === "Amira Shah");
  assert.ok(p && p.device === "Phone" && !list.some((x) => "token" in x || x.id.length > 12), "handles, never tokens");
  assert.strictEqual((await call("POST", `/api/auth/sessions/${p.id}/revoke`, office.cookie)).status, 200);
  assert.strictEqual((await call("GET", "/api/state", phone.cookie)).status, 401, "the phone is signed out");
});

test("the database browser never shows password hashes or two-factor secrets", async () => {
  const { cookie } = await signIn(await newDemo());
  const rows = (await call("GET", "/api/debug/table/users", cookie)).data.rows;
  assert.ok(rows.every((r) => r.totp_secret.includes("hidden") && r.pass_hash.endsWith("…")));
});

test("signing out while live updates are open ends the stream and doesn't crash the server", async () => {
  const sb = await newDemo();
  const { cookie } = await signIn(sb);
  const res = await fetch(base + "/api/events", { headers: { Cookie: cookie } });
  const reader = res.body.getReader(), dec = new TextDecoder();
  assert.match(dec.decode((await reader.read()).value), /event: hello/);
  await call("POST", "/api/auth/logout", cookie); // logging this request emits an event to office streams
  let rest = "";
  for (let r = await reader.read(); !r.done; r = await reader.read()) rest += dec.decode(r.value);
  assert.match(rest, /event: signedout/, "the stream is told, then closed");
  const other = await signIn(sb);
  assert.strictEqual((await call("GET", "/api/state", other.cookie)).status, 200, "the server is still up");
});

test("lots of failed attempts from one connection are slowed down", async () => {
  const sb = await newDemo();
  let last;
  for (let i = 0; i < 32; i++) last = await call("POST", "/api/auth/code", null, { challenge: "made-up", code: "123456" });
  assert.strictEqual(last.status, 429);
  assert.strictEqual((await password(sb, "sarah@airevalleyeyecare.example")).status, 429, "applies to every sign-in step");
});

test("wrong codes count against the account, so a known password can't be used to guess codes over and over", async () => {
  const sb = await newDemo();
  let last;
  // Several fresh challenges, a wrong code on each: the password is right every time, but the account still locks.
  const from = { "Fly-Client-IP": "203.0.113.9" }; // its own connection, so earlier tests' failures don't count
  const pwd = (email) => call("POST", "/api/auth/password", null, { sandbox: sb, email, password: DEMO_PASSWORD }, from);
  for (let i = 0; i < LOCK_AFTER; i++) {
    const pw = await pwd("amira@airevalleyeyecare.example");
    assert.strictEqual(pw.status, 200, `password ${i + 1} accepted while the account is open`);
    last = await call("POST", "/api/auth/code", null, { challenge: pw.data.challenge, code: "000000" }, from);
  }
  assert.strictEqual(last.status, 429); assert.match(last.data.error, /locked/);
  assert.strictEqual((await pwd("amira@airevalleyeyecare.example")).status, 429, "locked for the password step too");
  // A right code clears the count: a slip or two never adds up across days.
  const sarah = await pwd("sarah@airevalleyeyecare.example");
  await call("POST", "/api/auth/code", null, { challenge: sarah.data.challenge, code: "000000" }, from);
  const again = await pwd("sarah@airevalleyeyecare.example");
  const ok = await call("POST", "/api/auth/code", null, { challenge: again.data.challenge, code: await demoCode(again.data.challenge) }, from);
  assert.strictEqual(ok.status, 200);
});

test("the per-connection limit uses Fly's client address, which a caller can't change", async () => {
  await newDemo();
  let last;
  // On Fly, rotating X-Forwarded-For no longer gives a fresh allowance: the bucket is Fly-Client-IP.
  for (let i = 0; i < 32; i++) last = await call("POST", "/api/auth/code", null, { challenge: "made-up", code: "123456" }, { "Fly-Client-IP": "198.51.100.7", "X-Forwarded-For": "10.0.0." + i });
  assert.strictEqual(last.status, 429);
  const other = await call("POST", "/api/auth/code", null, { challenge: "made-up", code: "123456" }, { "Fly-Client-IP": "198.51.100.8" });
  assert.strictEqual(other.status, 401, "another connection isn't blocked");
});

test("a server with a live database never runs the demo shortcuts, even if DEMO_MODE is missing", () => {
  const { execFileSync } = require("node:child_process");
  const demoWith = (env) => execFileSync(process.execPath, ["-e", "process.stdout.write(String(require('./server/auth').DEMO))"],
    { env: { PATH: process.env.PATH, ...env }, cwd: require("node:path").join(__dirname, "..") }).toString();
  assert.strictEqual(demoWith({}), "true", "a plain demo server");
  assert.strictEqual(demoWith({ DATABASE_URL: "postgres://x@db.example/p" }), "false", "live database, DEMO_MODE unset");
  assert.strictEqual(demoWith({ DATABASE_URL: "postgres://x@db.example/p", DEMO_MODE: "1" }), "true", "only when asked for outright");
  assert.strictEqual(demoWith({ DEMO_MODE: "0" }), "false");
});
