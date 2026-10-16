"use strict";
process.env.ROUTING_PROVIDER = "estimate";
// Staff invitations and sign-in resets: a new person, or someone who has lost their phone or forgotten their
// password, gets a single-use link and sets up their own password and authenticator app on it.
const test = require("node:test");
const assert = require("node:assert");
const { start, server } = require("../server/index");
const auth = require("../server/auth");
const sandbox = require("../server/sandbox");

let base;
test.before(async () => { const s = await start(0); base = `http://127.0.0.1:${s.address().port}`; });
test.after(() => server.close());

async function call(method, path, cookie, body) {
  const res = await fetch(base + path, { method, headers: { "Content-Type": "application/json", "X-Domi": "1", ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json(), cookie: (res.headers.get("set-cookie") || "").split(";")[0] };
}
async function signIn(email, sandboxId, password = auth.DEMO_PASSWORD, secret) {
  if (!sandboxId) sandboxId = (await call("POST", "/api/demo/start")).data.sandbox;
  const pw = await call("POST", "/api/auth/password", null, { sandbox: sandboxId, email, password });
  if (pw.status !== 200) return { status: pw.status, error: pw.data.error, sandbox: sandboxId };
  const code = secret ? auth.hotp(auth.unbase32(secret), auth.stepAt() + 1) : (await call("GET", "/api/auth/demo-code?challenge=" + encodeURIComponent(pw.data.challenge))).data.code;
  const r = await call("POST", "/api/auth/code", null, { challenge: pw.data.challenge, code });
  return { token: r.cookie, sandbox: sandboxId, user: r.data.user, status: r.status, error: r.data.error };
}
const linkOf = (invite) => { const [, , code, tok] = new URL(invite.url).pathname.split("/"); return `/api/public/${code}/invite/${tok}`; };
const codeFor = (secret) => auth.hotp(auth.unbase32(secret), auth.stepAt());
const hours = [[540, 1020], [540, 1020], [540, 1020], [540, 1020], [540, 1020]];

test("a new clinician sets up their own password and app from the invitation, once", async () => {
  const o = await signIn("sarah@airevalleyeyecare.example");
  const add = await call("POST", "/api/team/clinicians", o.token, { name: "Nadia Khan", role: "Optometrist", email: "nadia@airevalleyeyecare.example", areaName: "Leeds", patch: "LS6", base: "LS6", hours });
  assert.strictEqual(add.status, 200, JSON.stringify(add.data));
  const inv = add.data.invite, link = linkOf(inv);
  assert.strictEqual(inv.kind, "invite");
  assert.ok(inv.expiresAt - Date.now() > 6.9 * 864e5, "lasts a week");

  // The email went out with the link; the office sees "Invited".
  const st = (await call("GET", "/api/state", o.token)).data;
  const team = (await call("GET", "/api/team", o.token)).data;
  assert.strictEqual(team.clinicians.find((c) => c.id === add.data.id).signin.state, "invited");
  sandbox.run(sandbox.get(o.sandbox), () => {
    const e = require("../server/db").db.prepare("SELECT * FROM emails WHERE kind = 'staff-invite' ORDER BY id DESC").get();
    assert.strictEqual(e.to_addr, "nadia@airevalleyeyecare.example");
    assert.ok(e.body.includes(inv.url));
  });
  assert.ok(st);

  const info = await call("GET", link);
  assert.strictEqual(info.status, 200);
  assert.strictEqual(info.data.first, "Nadia");
  assert.strictEqual(info.data.role, "clinician");

  for (const [pw, why] of [["short", /12 characters/], ["password12345", /easy to guess/], ["aaaaaaaaaaaaaa", /easy to guess/], ["my-nadia-account-x", /email address/]]) {
    const r = await call("POST", link + "/password", null, { password: pw });
    assert.strictEqual(r.status, 400, pw); assert.match(r.data.error, why);
  }
  const set = await call("POST", link + "/password", null, { password: "kettle-orange-harbour" });
  assert.strictEqual(set.status, 200);
  assert.match(set.data.otpauth, /^otpauth:\/\/totp\/Domi%3Anadia/);
  const wrong = await call("POST", link + "/confirm", null, { code: "000000" });
  assert.strictEqual(wrong.status, 400);
  const ok = await call("POST", link + "/confirm", null, { code: codeFor(set.data.secret) });
  assert.strictEqual(ok.status, 200, JSON.stringify(ok.data));
  assert.strictEqual(ok.data.email, "nadia@airevalleyeyecare.example");
  assert.strictEqual(ok.cookie, "", "not signed in by the link: they sign in as normal next");

  // Single use.
  assert.strictEqual((await call("GET", link)).status, 410);
  assert.strictEqual((await call("POST", link + "/password", null, { password: "another-long-password" })).status, 410);
  // And her own password and app now work for a normal sign-in; the demo password never did.
  assert.strictEqual((await signIn("nadia@airevalleyeyecare.example", o.sandbox)).status, 401);
  assert.strictEqual((await signIn("nadia@airevalleyeyecare.example", o.sandbox, "kettle-orange-harbour", set.data.secret)).status, 200);
  assert.strictEqual((await call("GET", "/api/team", o.token)).data.clinicians.find((c) => c.id === add.data.id).signin.state, "ready");
});

test("a lost phone: the office resets the sign-in, which stops the old one at once", async () => {
  const o = await signIn("sarah@airevalleyeyecare.example");
  const amira = await signIn("amira@airevalleyeyecare.example", o.sandbox);
  assert.strictEqual(amira.status, 200);
  const r = await call("POST", "/api/team/users/u-c1/invite", o.token);
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.strictEqual(r.data.kind, "reset");
  assert.ok(r.data.expiresAt - Date.now() <= 864e5, "a reset lasts a day");
  assert.strictEqual((await call("GET", "/api/state", amira.token)).status, 401, "signed out everywhere");
  assert.strictEqual((await signIn("amira@airevalleyeyecare.example", o.sandbox)).status, 401, "old password stops working");
  assert.strictEqual((await call("GET", "/api/team", o.token)).data.clinicians.find((c) => c.id === "c1").signin.state, "reset");

  // Sending another link cancels the first.
  const again = await call("POST", "/api/team/users/u-c1/invite", o.token);
  assert.strictEqual((await call("GET", linkOf(r.data))).status, 410);
  const link = linkOf(again.data);
  const set = await call("POST", link + "/password", null, { password: "harbour-kettle-orange" });
  assert.strictEqual((await call("POST", link + "/confirm", null, { code: codeFor(set.data.secret) })).status, 200);
  assert.strictEqual((await signIn("amira@airevalleyeyecare.example", o.sandbox, "harbour-kettle-orange", set.data.secret)).status, 200);
});

test("only the office sends links; not to themselves, not to switched-off accounts; links expire; wrong codes stop them", async () => {
  const o = await signIn("sarah@airevalleyeyecare.example");
  const amira = await signIn("amira@airevalleyeyecare.example", o.sandbox);
  assert.strictEqual((await call("POST", "/api/team/users/u-admin/invite", amira.token)).status, 403);
  assert.strictEqual((await call("POST", "/api/team/users/u-admin/invite", o.token)).status, 409, "not your own");

  const add = await call("POST", "/api/team/staff", o.token, { name: "Jo Bright", title: "Receptionist", email: "jo@airevalleyeyecare.example" });
  const link = linkOf(add.data.invite);
  // Ten wrong codes and the link stops working.
  const set = await call("POST", link + "/password", null, { password: "kettle-orange-harbour" });
  assert.strictEqual(set.status, 200);
  let last;
  for (let i = 0; i < 10; i++) last = await call("POST", link + "/confirm", null, { code: "000000" });
  assert.strictEqual(last.status, 410);
  assert.strictEqual((await call("GET", link)).status, 410);

  // A fresh link, then it runs out.
  const fresh = await call("POST", `/api/team/users/${add.data.id}/invite`, o.token);
  assert.strictEqual(fresh.data.kind, "invite", "never set up, so it's still an invitation");
  sandbox.run(sandbox.get(o.sandbox), () => require("../server/db").db.prepare("UPDATE invites SET expires_at = ? WHERE used_at IS NULL AND revoked = 0").run(Date.now() - 1));
  assert.strictEqual((await call("GET", linkOf(fresh.data))).status, 410);
  assert.strictEqual((await call("GET", "/api/team", o.token)).data.staff.find((u) => u.id === add.data.id).signin.state, "expired");

  // Switched off: no link works, and no new one can be sent.
  const third = await call("POST", `/api/team/users/${add.data.id}/invite`, o.token);
  assert.strictEqual((await call("POST", `/api/team/staff/${add.data.id}/active`, o.token, { active: false })).status, 200);
  assert.strictEqual((await call("GET", linkOf(third.data))).status, 410);
  assert.strictEqual((await call("POST", `/api/team/users/${add.data.id}/invite`, o.token)).status, 409);

  // The office's table view never shows the link hashes or the chosen secrets.
  const t = (await call("GET", "/api/debug/table/invites", o.token)).data;
  assert.ok(t.rows.length > 0 && t.rows.every((r) => /hash of the link/.test(r.id)));
});
