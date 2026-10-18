"use strict";
// The live store against a real Postgres. Skipped unless PG_TEST_URL points at a throwaway database, e.g.
//   PG_TEST_URL=postgres://postgres@localhost:5433/domi_test npm test
const test = require("node:test");
const assert = require("node:assert");

const URL_ = process.env.PG_TEST_URL;
let pgOk = !!URL_;
try { require.resolve("pg"); } catch { pgOk = false; }
const opts = { skip: pgOk ? false : "set PG_TEST_URL (and npm install) to test the live store" };

const sandbox = require("../server/sandbox");
const live = require("../server/live");
const svc = require("../server/service");
const { db } = require("../server/db");
const office = { id: "u-test", name: "Office Tester", role: "admin" };

async function freshDatabase() {
  const { Pool } = require("pg");
  const p = new Pool({ connectionString: URL_ });
  await p.query("DROP SCHEMA IF EXISTS domi CASCADE; DROP SCHEMA IF EXISTS p_test1 CASCADE;");
  await p.end();
}
const inPg = async (sql, args = []) => (await live.poolForTests().query(sql, args)).rows;

test("a live practice's changes are saved to Postgres and come back after a restart", opts, async () => {
  await freshDatabase();
  assert.deepStrictEqual(await live.start(URL_), []);
  const sb = await live.addPractice({ code: "test1", name: "Test Home Optics" });
  assert.strictEqual(sb.id, "TEST1");
  assert.ok(sb.live);
  // A new practice starts empty: no sample patients.
  assert.strictEqual(sandbox.run(sb, () => db.prepare("SELECT COUNT(*) AS n FROM patients").get().n), 0);
  // Its settings (with a lead key made for it) are saved straight away.
  const [rec] = await inPg("SELECT name, settings FROM domi.practices WHERE code = 'TEST1'");
  assert.strictEqual(rec.settings.practice, "Test Home Optics");
  assert.ok(rec.settings.leadsKey);

  const clin = await sandbox.run(sb, () => svc.saveClinician({ name: "Ayesha Khan", role: "Optometrist", email: "ayesha@testoptics.example", areaName: "Bolton", patch: "BL1, BL2", near: "BL3", base: "BL1 1AA", hours: [[540, 1050], [540, 1050], null, [540, 1050], [540, 1050]] }, office));
  const pat = await sandbox.run(sb, () => svc.createPatient({ name: "Doris Ingham", addr: "4 Mill Lane, Bolton", pc: "BL1 4AB", phone: "07700 900111", poa: "Son, Peter Ingham 07700 900222", share: "yes" }, office));
  sandbox.run(sb, () => svc.saveSettings({ practice: "Test Home Optics Ltd", recallAt: 600 }, office));
  await sandbox.settle();

  const [p] = await inPg("SELECT name, pc, poa, share FROM p_test1.patients");
  assert.deepStrictEqual(p, { name: "Doris Ingham", pc: "BL1 4AB", poa: "Son, Peter Ingham 07700 900222", share: "yes" });
  assert.strictEqual((await inPg("SELECT COUNT(*)::int AS n FROM p_test1.clinicians"))[0].n, 1);
  assert.ok((await inPg("SELECT COUNT(*)::int AS n FROM p_test1.audit"))[0].n >= 2, "the audit trail is saved too");
  assert.strictEqual((await inPg("SELECT settings->>'practice' AS v FROM domi.practices WHERE code = 'TEST1'"))[0].v, "Test Home Optics Ltd");

  // Edit and remove: an update lands as an update, a removal as a removal.
  const pid = (pat && (pat.id || pat.patientId)) || (await inPg("SELECT id FROM p_test1.patients"))[0].id;
  sandbox.run(sb, () => db.prepare("UPDATE patients SET phone = '07700 900333' WHERE id = ?").run(pid));
  sandbox.run(sb, () => db.prepare("DELETE FROM notes WHERE patient_id = ?").run(pid));
  await sandbox.settle();
  assert.strictEqual((await inPg("SELECT phone FROM p_test1.patients WHERE id = $1", [pid]))[0].phone, "07700 900333");
  assert.strictEqual((await inPg("SELECT COUNT(*)::int AS n FROM p_test1.notes"))[0].n, 0);

  // An invitation sent before a restart still works after it (the link's hash is saved, not the link).
  const ayesha = sandbox.run(sb, () => db.prepare("SELECT id FROM users WHERE email = 'ayesha@testoptics.example'").get());
  const invite = sandbox.run(sb, () => require("../server/invites").issue(ayesha.id, office, "https://app.example", { isNew: true }));
  await sandbox.settle();
  assert.strictEqual((await inPg("SELECT COUNT(*)::int AS n FROM p_test1.invites WHERE user_id = $1", [ayesha.id]))[0].n, 1);

  // "Restart": stop, forget the practice, open it again from Postgres.
  await live.stop();
  const [reopened] = await live.start(URL_);
  assert.strictEqual(reopened.id, "TEST1");
  const back = sandbox.run(reopened, () => svc.getPatient(pid));
  assert.strictEqual(back.name, "Doris Ingham");
  assert.strictEqual(back.phone, "07700 900333");
  assert.strictEqual(back.poa, "Son, Peter Ingham 07700 900222");
  assert.strictEqual(reopened.settings.practice, "Test Home Optics Ltd");
  assert.ok(clin, "clinician saved");
  // A new live account never gets the demo password: nobody can sign in until they set their own.
  const acct = sandbox.run(reopened, () => db.prepare("SELECT pass_hash FROM users WHERE email = 'ayesha@testoptics.example'").get());
  assert.ok(acct && !(await require("../server/auth").checkPassword(require("../server/auth").DEMO_PASSWORD, acct.pass_hash)));
  assert.strictEqual(sandbox.run(reopened, () => db.prepare("SELECT COUNT(*) AS n FROM clinicians").get().n), 1);
  assert.strictEqual(sandbox.run(reopened, () => require("../server/invites").describe(invite.url.split("/").pop())).first, "Ayesha");

  // New rows after a restart don't collide with the ones loaded back in.
  sandbox.run(reopened, () => svc.addNote(pid, "Phoned about a visit next week.", office));
  await sandbox.settle();
  assert.strictEqual((await inPg("SELECT COUNT(*)::int AS n FROM p_test1.notes"))[0].n, 1);

  // The live clock is UK time, not the demo's 10:20.
  const uk = sandbox.londonSec();
  assert.ok(Math.abs(sandbox.nowSec(reopened) - uk) <= 1);
  // A live practice can't be wiped by the demo's reset.
  assert.throws(() => sandbox.reset(reopened), /can't be reset/);
  await live.stop();
});

test("sign-ins to a live practice survive a restart; the database never holds the token", opts, async () => {
  const auth = require("../server/auth");
  await live.start(URL_);
  assert.ok((await live.health()).ms >= 0, "the health check reaches the database");
  const s = auth.createSession({ sbId: "TEST1", uid: "u-test", kind: "password", ua: "Test browser" });
  const demo = auth.createSession({ sbId: sandbox.create().id, uid: "u-admin", kind: "password", ua: "x" });
  await live.sessionsSaved();
  const rows = await inPg("SELECT * FROM domi.sessions");
  assert.strictEqual(rows.length, 1, "only the live practice's session is kept, not the demo's");
  assert.strictEqual(rows[0].id, s.id);
  assert.notStrictEqual(rows[0].id, s.token);
  assert.ok(!JSON.stringify(rows).includes(s.token), "the cookie's token is never stored");
  // One that has gone idle meanwhile isn't brought back.
  await inPg("INSERT INTO domi.sessions (id, practice, uid, kind, created, last_seen) VALUES ('old', 'TEST1', 'u-test', 'password', $1, $1)", [Date.now() - 3 * 3600e3]);

  // Restart: memory is empty, then the server loads the sessions back.
  await live.stop(); auth.forgetSessionsForTests();
  assert.strictEqual(auth.getSession(s.token), null);
  await live.start(URL_);
  const back = auth.getSession(s.token);
  assert.ok(back, "still signed in after the restart");
  assert.strictEqual(back.uid, "u-test"); assert.strictEqual(back.sbId, "TEST1");
  assert.strictEqual(auth.getSession(demo.token), null, "demo sign-ins aren't kept");
  await live.sessionsSaved();
  assert.deepStrictEqual((await inPg("SELECT id FROM domi.sessions ORDER BY id")).map((r) => r.id), [s.id], "the idle one is deleted");

  // Signing out deletes it.
  auth.endSession(back.id);
  await live.sessionsSaved();
  assert.strictEqual((await inPg("SELECT COUNT(*)::int AS n FROM domi.sessions"))[0].n, 0);
  await live.stop();
});

test("a live practice is never evicted with the demos", opts, async () => {
  const before = sandbox.all().filter((s) => s.live).length;
  for (let i = 0; i < 3; i++) sandbox.create();
  assert.strictEqual(sandbox.all().filter((s) => s.live).length, before);
});
