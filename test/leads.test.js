"use strict";
process.env.ROUTING_PROVIDER = "estimate";
// Leads from the practice's Facebook ads: a connector posts them, each gets a thank-you email, the office calls.
const test = require("node:test");
const assert = require("node:assert");
const { start, server } = require("../server/index");
const { normalise } = require("../server/leads");

let base;
test.before(async () => { const s = await start(0); base = `http://127.0.0.1:${s.address().port}`; });
test.after(() => { delete process.env.LEADS_KEY; server.close(); });
const call = async (method, path, cookie, body, headers = {}) => {
  const res = await fetch(base + path, { method, headers: { "Content-Type": "application/json", "X-Domi": "1", ...headers, ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json() };
};
async function login(brand) {
  const sandbox = (await call("POST", "/api/demo/start", null, { brand })).data.sandbox;
  const email = brand === "hvo" ? "sarah@homevisitingoptics.example" : "sarah@airevalleyeyecare.example";
  const pw = await call("POST", "/api/auth/password", null, { sandbox, email, password: require("../server/auth").DEMO_PASSWORD });
  const code = (await call("GET", "/api/auth/demo-code?challenge=" + encodeURIComponent(pw.data.challenge))).data.code;
  const res = await fetch(base + "/api/auth/code", { method: "POST", headers: { "Content-Type": "application/json", "X-Domi": "1" }, body: JSON.stringify({ challenge: pw.data.challenge, code }) });
  return { token: (res.headers.get("set-cookie") || "").split(";")[0], sandbox };
}

test("reads both what Zapier or Make send and Meta's own lead format", () => {
  const flat = normalise({ full_name: "Mary Test", phone_number: "+44 7700 900999", email: "Mary@Example.com", post_code: "bl1 2ab", ad_name: "Free NHS eye test at home", who_is_the_eye_test_for: "My dad" });
  assert.deepStrictEqual([flat.name, flat.phone, flat.email, flat.pc, flat.campaign], ["Mary Test", "07700 900999", "mary@example.com", "BL1 2AB", "Free NHS eye test at home"]);
  assert.deepStrictEqual(flat.answers, [["Who is the eye test for?", "My dad"]], "other questions are kept as asked");
  const meta = normalise({ campaign_name: "Autumn", field_data: [{ name: "first_name", values: ["Bob"] }, { name: "last_name", values: ["Meta"] }, { name: "email", values: ["bob@example.com"] }] });
  assert.deepStrictEqual([meta.name, meta.email, meta.campaign, meta.phone], ["Bob Meta", "bob@example.com", "Autumn", null]);
});

test("a lead from the ad: saved for the office, thanked by email with the office hours, then marked as called", async () => {
  const office = await login("hvo");
  const before = (await call("GET", "/api/state", office.token)).data;
  assert.strictEqual(before.leads.length, 3, "this morning's leads are waiting");
  assert.ok(before.leadEmails.every((m) => /office hours are/.test(m.body)));

  await call("PUT", "/api/settings", office.token, { officeHours: "Monday to Friday, 8.30am to 4.30pm." });
  const r = await call("POST", `/api/public/${office.sandbox}/leads`, null, { full_name: "Margaret Booth", phone_number: "07700 900971", email: "margaret@example.com", post_code: "BL1 4QR", ad_name: "Free NHS eye test at home", who_is_the_eye_test_for: "My mum or dad" });
  assert.strictEqual(r.status, 200);
  assert.ok(r.data.emailed);
  assert.match(r.data.email.body, /^Hi Margaret,/);
  assert.match(r.data.email.body, /office hours are Monday to Friday, 8\.30am to 4\.30pm\./, "the office's own hours, without a doubled full stop");
  assert.match(r.data.email.body, /01204 292 005/, "the practice's phone number");
  assert.match(r.data.email.subject, /Home Visiting Optics/);

  const s = (await call("GET", "/api/state", office.token)).data;
  const lead = s.leads.find((l) => l.name === "Margaret Booth");
  assert.strictEqual(lead.status, "new");
  assert.strictEqual(s.leadEmails.find((m) => m.leadId === lead.id).to, "margaret@example.com");

  const done = await call("POST", `/api/leads/${lead.id}/status`, office.token, { status: "booked", note: "Booked for Tuesday morning" });
  assert.strictEqual(done.data.status, "booked");
  assert.strictEqual(done.data.handledBy, "Sarah Lane");
  const audit = (await call("GET", "/api/debug/table/audit", office.token)).data;
  assert.ok(JSON.stringify(audit).includes("lead.received"), "the lead is in the audit trail");
  assert.ok(!JSON.stringify(audit).includes("Margaret"), "but no personal details are");
});

test("an existing patient is recognised, a lead needs a way to reach them, and only the office sees leads", async () => {
  const office = await login("domi");
  const s = (await call("GET", "/api/state", office.token)).data;
  const p = s.patients.find((x) => x.phone);
  await call("POST", `/api/public/${office.sandbox}/leads`, null, { full_name: p.name, phone_number: p.phone });
  const lead = (await call("GET", "/api/state", office.token)).data.leads.find((l) => l.name === p.name);
  assert.strictEqual(lead.patientId, p.id);
  assert.strictEqual((await call("POST", `/api/public/${office.sandbox}/leads`, null, { full_name: "No Contact" })).status, 400);
  assert.strictEqual((await call("POST", "/api/leads/ld1/status", null, { status: "booked" })).status, 401);
});

test("with LEADS_KEY set, a connector must send it; the test ad form still works", async () => {
  const office = await login("domi");
  process.env.LEADS_KEY = "k-123";
  const body = { full_name: "Key Test", email: "key@example.com" };
  assert.strictEqual((await call("POST", `/api/public/${office.sandbox}/leads`, null, body)).status, 403);
  assert.strictEqual((await call("POST", `/api/public/${office.sandbox}/leads?key=k-123`, null, body)).status, 200);
  assert.strictEqual((await call("POST", `/api/public/${office.sandbox}/leads`, null, body, { "X-Domi-Key": "k-123" })).status, 200);
  assert.strictEqual((await call("POST", `/api/public/${office.sandbox}/leads`, null, { ...body, test: true, formMs: 5000 })).status, 200);
  const bot = await call("POST", `/api/public/${office.sandbox}/leads`, null, { ...body, full_name: "Bot", test: true, formMs: 200 });
  assert.strictEqual(bot.status, 200, "a bot gets an ordinary answer");
  assert.ok(!(await call("GET", "/api/state", office.token)).data.leads.some((l) => l.name === "Bot"), "but nothing is saved");
  delete process.env.LEADS_KEY;
});
