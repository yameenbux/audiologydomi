"use strict";
process.env.ROUTING_PROVIDER = "estimate";
const test = require("node:test");
const assert = require("node:assert");
const imp = require("../server/importer");
const { start, server } = require("../server/index");

/* ---------- The parser and the checks, no server ---------- */

test("CSV: quotes, commas and line breaks inside quotes, CRLF, a byte-order mark, and semicolons", () => {
  const rows = imp.parseCsv('﻿Name,Notes\r\n"Holt, Margaret","Says ""hello""\nand bye"\r\n\r\nJoan,\r\n');
  assert.deepStrictEqual(rows, [["Name", "Notes"], ["Holt, Margaret", 'Says "hello"\nand bye'], ["Joan", ""]]);
  assert.deepStrictEqual(imp.parseCsv("a;b\n1;2"), [["a", "b"], ["1", "2"]]);
});

test("columns are recognised from the names people use", () => {
  const m = imp.guessMapping(["Forename", "Surname", "D.O.B", "Address", "Post Code", "Mobile No", "Landline", "NOK", "NOK phone", "Reason for home visit", "Last eye test", "Notes", "Favourite colour"]);
  assert.deepStrictEqual(m, ["first", "last", "dob", "addr", "pc", "phone", "phone2", "rep", "repPhone", "eligibility", "lastTest", "notes", null]);
  assert.deepStrictEqual(imp.guessMapping(["Name", "Surname"]), ["first", "last"], "a Name column next to Surname is first names");
});

test("UK dates, day first; phones and postcodes tidied", () => {
  for (const s of ["3/4/1942", "03-04-42", "1942-04-03", "3rd April 1942", "3 Apr, 1942"]) assert.strictEqual(imp.parseDate(s).iso, "1942-04-03", s);
  assert.strictEqual(imp.parseDate("31/02/1940"), null, "no 31st of February");
  assert.deepStrictEqual(imp.parsePhone("7700 900112"), { kind: "mobile", value: "07700 900112" }, "a leading zero dropped by the spreadsheet");
  assert.deepStrictEqual(imp.parsePhone("+44 1204 292005"), { kind: "landline", value: "01204 292005" });
  assert.strictEqual(imp.parsePhone("01614960123").value, "0161 496 0123");
  assert.deepStrictEqual(imp.parsePostcode("bl14ab"), { kind: "full", value: "BL1 4AB" });
  assert.strictEqual(imp.parsePostcode("BL1").kind, "district");
  assert.strictEqual(imp.parsePostcode("Bolton").kind, null);
});

test("each row: errors stop it, warnings don't; landline-only patients are phoned; recalls are worked out", () => {
  const csv = [
    "Name,Postcode,Mobile,DOB,Reason,Last test,Address",
    "MARGARET HOLT,bl1 4ab,07700900533,12/03/1945,Dementia,15/10/2025,14 Ash Grove",
    "No Postcode,,07700900534,,,,",
    "Bad Postcode,Bolton,07700900535,,,,",
    "Joan Landline,WN1 1AA,01942 123456,01/01/1950,housebound,01/09/2024,2 Hill St",
    "margaret holt,BL1 4AB,07700 900533,,,,",
  ].join("\n");
  const r = imp.check(csv, null, []);
  assert.deepStrictEqual(r.counts, { total: 5, ready: 2, duplicate: 1, error: 2, warnings: 1 });
  const [m, np, bp, joan, dup] = r.rows;
  assert.strictEqual(m.patient.name, "Margaret Holt", "capitals tidied");
  assert.strictEqual(m.patient.pc, "BL1 4AB");
  assert.strictEqual(m.patient.age, 81);
  assert.deepStrictEqual(m.recall, { dueDay: 3, reason: "Yearly NHS sight test (over 70)" });
  assert.match(np.errors[0], /No postcode/);
  assert.match(bp.errors[0], /isn't a UK postcode/);
  assert.strictEqual(joan.patient.contact, "Call");
  assert.ok(joan.warnings.some((w) => /Landline only/.test(w)));
  assert.ok(joan.warnings.some((w) => /"housebound" alone/.test(w)), "a generic reason is flagged for the claim");
  assert.strictEqual(joan.recall.dueDay, -406, "over 70, so yearly: overdue");
  assert.strictEqual(dup.status, "duplicate");
  assert.match(dup.duplicateOf, /row 2/);
  assert.deepStrictEqual(imp.check("Phone\n0770", null, []).missing, ["a name", "a postcode"]);
  assert.throws(() => imp.check("Name,Postcode", null, []), /header row and at least one/);
});

/* ---------- Through the API ---------- */
let base;
test.before(async () => { const s = await start(0); base = `http://127.0.0.1:${s.address().port}`; });
test.after(() => server.close());
const call = async (method, path, cookie, body) => {
  const res = await fetch(base + path, { method, headers: { "Content-Type": "application/json", "X-Domi": "1", ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json(), cookie: (res.headers.get("set-cookie") || "").split(";")[0] };
};
async function login(email, sandbox) {
  if (!sandbox) sandbox = (await call("POST", "/api/demo/start")).data.sandbox;
  const pw = await call("POST", "/api/auth/password", null, { sandbox, email, password: require("../server/auth").DEMO_PASSWORD });
  const code = (await call("GET", "/api/auth/demo-code?challenge=" + encodeURIComponent(pw.data.challenge))).data.code;
  const r = await call("POST", "/api/auth/code", null, { challenge: pw.data.challenge, code });
  return { token: r.cookie, sandbox: r.data.sandbox };
}

const SHEET = [
  "First name,Surname,Address,Town,Post code,Mobile,Date of birth,Why home visit,Next of kin,NOK phone,Last eye test,Notes",
  "Edith,Crompton,4 Chorley New Road,Bolton,BL1 4QR,07700 900801,02/02/1938,Severe arthritis,Son Paul,07700 900802,01/10/2025,Keysafe 1234",
  "Albert,Hesketh,12 Wigan Lane,Wigan,WN1 2LF,07700 900803,15/06/1962,Dementia,,,10/03/2025,",
  "Dorothy,Fenwick,12 Weetwood Lane,Leeds,LS16 7SN,07700 900112,,,,,,",
  "Broken,Row,,,,07700 900804,,,,,,",
].join("\n");

test("import: preview saves nothing; commit saves what passed, skips duplicates, and adds recalls that are due", async () => {
  const office = await login("sarah@airevalleyeyecare.example");
  const before = (await call("GET", "/api/state", office.token)).data;
  const pv = await call("POST", "/api/import/preview", office.token, { csv: SHEET });
  assert.strictEqual(pv.status, 200);
  assert.deepStrictEqual(pv.data.counts, { total: 4, ready: 2, duplicate: 1, error: 1, warnings: 2 });
  assert.ok(pv.data.rows[0].warnings.includes("BL1 is outside the towns you cover"), "the Leeds demo practice doesn't cover Bolton");
  assert.match(pv.data.rows[2].duplicateOf, /Dorothy Fenwick, already on Domi/);
  assert.strictEqual((await call("GET", "/api/state", office.token)).data.patients.length, before.patients.length, "a preview saves nothing");

  const c = await call("POST", "/api/import/commit", office.token, { csv: SHEET, mapping: pv.data.mapping });
  assert.strictEqual(c.status, 200);
  assert.deepStrictEqual(c.data, { imported: 2, duplicates: 1, errors: 1, recalls: 1 });
  const s = (await call("GET", "/api/state", office.token)).data;
  const edith = s.patients.find((p) => p.name === "Edith Crompton");
  assert.strictEqual(edith.addr, "4 Chorley New Road, Bolton");
  assert.strictEqual(edith.eligibility, "Severe arthritis");
  assert.strictEqual(edith.rep, "Son Paul, 07700 900802");
  assert.strictEqual(edith.age, 88);
  assert.ok(s.recalls.some((r) => r.patientId === edith.id && r.dueDay === -11), "Edith (88, tested a year ago) is due, so she's recalled");
  assert.ok(s.waitlist.some((w) => w.patientId === edith.id && w.source === "recall"), "and joins the refill pool");
  assert.ok(!s.recalls.some((r) => s.patients.find((p) => p.id === r.patientId).name === "Albert Hesketh"), "Albert (64) is every two years, so not due until March 2027");
  const rec = (await call("GET", `/api/patients/${edith.id}`, office.token)).data;
  assert.match(rec.history[0].body, /Imported from spreadsheet\. Keysafe 1234/);

  const again = await call("POST", "/api/import/commit", office.token, { csv: SHEET, mapping: pv.data.mapping });
  assert.strictEqual(again.status, 400, "importing the same file twice adds nobody");
  const audit = (await call("GET", "/api/debug/overview", office.token)).data.audit.find((a) => a.action === "patients.import");
  assert.doesNotMatch(audit.detail, /Edith|Crompton|0770/, "the audit log records counts, never patient details");
});

test("import: office only; a file must have names and postcodes; size is limited", async () => {
  const office = await login("sarah@airevalleyeyecare.example");
  const amira = await login("amira@airevalleyeyecare.example", office.sandbox);
  assert.strictEqual((await call("POST", "/api/import/preview", amira.token, { csv: SHEET })).status, 403);
  assert.strictEqual((await call("POST", "/api/import/commit", amira.token, { csv: SHEET })).status, 403);
  const noPc = await call("POST", "/api/import/commit", office.token, { csv: "Name,Phone\nAnn,07700900111" });
  assert.strictEqual(noPc.status, 400);
  assert.match(noPc.data.error, /postcode/);
  const big = "Name,Postcode\n" + "Ann Example,BL1 4AB\n".repeat(5001);
  assert.match((await call("POST", "/api/import/preview", office.token, { csv: big })).data.error, /up to 5000/);
});
