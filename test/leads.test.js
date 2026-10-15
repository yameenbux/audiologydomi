"use strict";
process.env.ROUTING_PROVIDER = "estimate";
// Leads from the practice's Facebook ads: a connector posts them, each gets a thank-you email, the office calls.
const test = require("node:test");
const assert = require("node:assert");
const { start, server } = require("../server/index");
const { normalise } = require("../server/leads");

let base;
test.before(async () => { const s = await start(0); base = `http://127.0.0.1:${s.address().port}`; });
test.after(() => { delete process.env.META_GRAPH_URL; server.close(); });
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
// A connector posts from outside: no app header, no cookie, just the practice's private link.
const hook = async (path, body, headers = {}) => {
  const res = await fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
  return { status: res.status, data: await res.json().catch(() => ({})) };
};
const linkOf = async (office) => (await call("GET", "/api/leads/connection", office.token)).data;

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
  const link = await linkOf(office);
  const r = await hook(new URL(link.hookUrl).pathname + new URL(link.hookUrl).search, { full_name: "Margaret Booth", phone_number: "07700 900971", email: "margaret@example.com", post_code: "BL1 4QR", ad_name: "Free NHS eye test at home", who_is_the_eye_test_for: "My mum or dad" });
  assert.strictEqual(r.status, 200);
  assert.ok(r.data.emailed);
  assert.match(r.data.email.body, /^Hi Margaret,/);
  assert.match(r.data.email.body, /office hours are Monday to Friday, 8\.30am to 4\.30pm\./, "the office's own hours, without a doubled full stop");
  assert.match(r.data.email.body, /call us on 01204 292 005 or email info@homevisitingoptics\.co\.uk\./, "the practice's phone and email");
  assert.strictEqual(before.settings.officeHours, "Monday to Friday, 9am to 5.30pm", "their opening hours, from their website");
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
  const link = new URL((await linkOf(office)).hookUrl), at = link.pathname + link.search;
  await hook(at, { full_name: p.name, phone_number: p.phone });
  const lead = (await call("GET", "/api/state", office.token)).data.leads.find((l) => l.name === p.name);
  assert.strictEqual(lead.patientId, p.id);
  assert.strictEqual((await hook(at, { full_name: "No Contact" })).status, 400);
  assert.strictEqual((await call("POST", "/api/leads/ld1/status", null, { status: "booked" })).status, 401);
});

test("each practice's private link needs its own key; a new key stops the old link; the test ad form still works", async () => {
  const office = await login("domi"), other = await login("domi");
  const link = await linkOf(office), u = new URL(link.hookUrl);
  const body = { full_name: "Key Test", email: "key@example.com" };
  assert.strictEqual((await hook(u.pathname, body)).status, 403, "no key");
  assert.strictEqual((await hook(u.pathname + "?key=wrong", body)).status, 403);
  assert.strictEqual((await hook(u.pathname, body, { "X-Domi-Key": link.key })).status, 200, "the key as a header");
  const theirs = new URL((await linkOf(other)).hookUrl);
  assert.strictEqual((await hook(u.pathname + theirs.search, body)).status, 403, "another practice's key doesn't open this practice");
  const fresh = (await call("POST", "/api/leads/connection/key", office.token)).data;
  assert.notStrictEqual(fresh.key, link.key);
  assert.strictEqual((await hook(u.pathname + u.search, body)).status, 403, "the old link stops working");
  // The key never reaches the browser in the practice's settings
  assert.ok(!JSON.stringify((await call("GET", "/api/state", office.token)).data).includes(fresh.key));
  assert.strictEqual((await call("GET", "/api/leads/connection", null)).status, 401);
  // The test ad form
  assert.strictEqual((await call("POST", `/api/public/${office.sandbox}/leads`, null, { ...body, test: true, formMs: 5000 })).status, 200);
  const bot = await call("POST", `/api/public/${office.sandbox}/leads`, null, { ...body, full_name: "Bot", test: true, formMs: 200 });
  assert.strictEqual(bot.status, 200, "a bot gets an ordinary answer");
  assert.ok(!(await call("GET", "/api/state", office.token)).data.leads.some((l) => l.name === "Bot"), "but nothing is saved");
  const st = (await linkOf(office)).status;
  assert.strictEqual(st.lastVia, "test form");
});

test("Facebook's own webhook: the check, signed notices only, the lead fetched from Facebook, and no doubles", async () => {
  const office = await login("hvo");
  // A stand-in for Facebook's Graph API, so the test doesn't call Facebook
  const http = require("node:http");
  const graph = http.createServer((req, res) => {
    const ok = req.url.includes("access_token=" + "T".repeat(60));
    res.writeHead(ok ? 200 : 400, { "Content-Type": "application/json" });
    res.end(JSON.stringify(ok ? { ad_name: "Free NHS eye test at home", field_data: [{ name: "full_name", values: ["Edith Graph"] }, { name: "phone_number", values: ["07700 900888"] }] } : { error: { message: "Invalid OAuth access token." } }));
  });
  await new Promise((r) => graph.listen(0, r));
  process.env.META_GRAPH_URL = `http://127.0.0.1:${graph.address().port}`;
  const crypto = require("node:crypto");
  const link = await linkOf(office), cb = new URL(link.meta.callbackUrl).pathname;
  // Meta's one-off check
  const bad = await fetch(`${base}${cb}?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=123`);
  assert.strictEqual(bad.status, 403);
  const good = await fetch(`${base}${cb}?hub.mode=subscribe&hub.verify_token=${link.meta.verifyToken}&hub.challenge=8675309`);
  assert.strictEqual(await good.text(), "8675309");
  // Not connected yet
  const notice = JSON.stringify({ object: "page", entry: [{ id: "1234567", changes: [{ field: "leadgen", value: { leadgen_id: "555000111", page_id: "1234567" } }] }] });
  assert.strictEqual((await hook(cb, notice)).status, 409);
  // Connecting: checked, saved, never sent back
  assert.match((await call("PUT", "/api/leads/connection/meta", office.token, { pageId: "abc" })).data.error, /Page ID/);
  const secret = "a".repeat(32);
  const saved = (await call("PUT", "/api/leads/connection/meta", office.token, { pageId: "1234567", appSecret: secret, pageToken: "T".repeat(60) })).data;
  assert.ok(saved.meta.connected && saved.meta.hasSecret && saved.meta.tokenEnd === "TTTT");
  assert.ok(!JSON.stringify(saved).includes(secret), "the app secret is never sent back");
  const sign = (b, s = secret) => "sha256=" + crypto.createHmac("sha256", s).update(b).digest("hex");
  assert.strictEqual((await hook(cb, notice)).status, 403, "unsigned");
  assert.strictEqual((await hook(cb, notice, { "X-Hub-Signature-256": sign(notice, "b".repeat(32)) })).status, 403, "signed with another secret");
  const ok = await hook(cb, notice, { "X-Hub-Signature-256": sign(notice) });
  assert.deepStrictEqual(ok.data, { ok: true, leads: 1 });
  await new Promise((r) => setTimeout(r, 300));
  await hook(cb, notice, { "X-Hub-Signature-256": sign(notice) }); // Facebook sends it again
  await new Promise((r) => setTimeout(r, 300));
  const got = (await call("GET", "/api/state", office.token)).data.leads.filter((l) => l.name === "Edith Graph");
  assert.strictEqual(got.length, 1, "saved once");
  assert.strictEqual(got[0].campaign, "Free NHS eye test at home");
  assert.strictEqual((await linkOf(office)).status.lastVia, "Facebook");
  // A bad token shows up as a problem in Settings rather than vanishing
  await call("PUT", "/api/leads/connection/meta", office.token, { pageToken: "X".repeat(60) });
  const n2 = notice.replace("555000111", "555000222");
  await hook(cb, n2, { "X-Hub-Signature-256": sign(n2) });
  await new Promise((r) => setTimeout(r, 300));
  assert.match((await linkOf(office)).status.error, /Invalid OAuth access token/);
  const audit = JSON.stringify((await call("GET", "/api/debug/table/audit", office.token)).data);
  assert.ok(audit.includes("Facebook connection") && !audit.includes(secret) && !audit.includes("T".repeat(60)));
  graph.close();
});
