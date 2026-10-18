"use strict";
process.env.ROUTING_PROVIDER = "estimate";
// The branded North West demo, the referral form and route planning, end to end through the API.
const test = require("node:test");
const assert = require("node:assert");
const { start, server } = require("../server/index");

let base;
test.before(async () => { const s = await start(0); base = `http://127.0.0.1:${s.address().port}`; });
test.after(() => server.close());
const call = async (method, path, cookie, body) => {
  const res = await fetch(base + path, { method, headers: { "Content-Type": "application/json", "X-Domi": "1", ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json(), cookie: (res.headers.get("set-cookie") || "").split(";")[0] };
};
async function login(email, brand, sandbox) {
  if (!sandbox) sandbox = (await call("POST", "/api/demo/start", null, { brand })).data.sandbox;
  const pw = await call("POST", "/api/auth/password", null, { sandbox, email, password: require("../server/auth").DEMO_PASSWORD });
  assert.strictEqual(pw.status, 200, `sign in as ${email}`);
  const code = (await call("GET", "/api/auth/demo-code?challenge=" + encodeURIComponent(pw.data.challenge))).data.code;
  const r = await call("POST", "/api/auth/code", null, { challenge: pw.data.challenge, code });
  return { token: r.cookie, sandbox: r.data.sandbox };
}
const HVO = "sarah@homevisitingoptics.example";

test("the branded demo: the practice's name, look and towns, 50 invented patients across them", async () => {
  const meta = (await call("GET", "/api/meta?brand=hvo")).data;
  assert.strictEqual(meta.brand.practice, "Home Visiting Optics");
  assert.match(meta.brand.logo, /^https:\/\/www\.homevisitingoptics\.co\.uk\//, "their logo is loaded from their own site, not copied");
  assert.strictEqual(meta.demoUsers[0].email, HVO);
  assert.deepStrictEqual(meta.areas.map((a) => a.town), ["Blackburn", "Blackpool", "Bolton", "Bury", "Manchester", "Oldham", "Warrington", "Wigan"]);
  assert.strictEqual((await call("GET", "/api/meta")).data.brand.id, "domi", "unbranded by default");

  const office = await login(HVO, "hvo");
  const s = (await call("GET", "/api/state", office.token)).data;
  assert.strictEqual(s.settings.practice, "Home Visiting Optics");
  assert.strictEqual(s.patients.length, 53, "50 in their homes, and 3 residents of one nursing home");
  const districts = new Set(meta.areas.flatMap((a) => a.districts));
  assert.ok(s.patients.every((p) => districts.has(p.pc.split(" ")[0])), "everyone lives in the towns they cover");
  assert.ok(s.patients.every((p) => /^07700 900\d{3}$/.test(p.phone)), "only Ofcom's drama numbers");
  for (const t of meta.areas) assert.ok(s.patients.some((p) => t.districts.includes(p.pc.split(" ")[0])), `someone in ${t.town}`);
  assert.ok(s.appts.length >= 70, "a full week");
  assert.ok(s.patients.every((p) => p.eligibility), "every patient has a home-visit reason");
  // HVO phone their patients, so a cancellation becomes a call list by default; with texts switched on, the offer
  // carries the practice's name.
  assert.strictEqual(s.settings.mode, "phone");
  assert.strictEqual((await call("POST", "/api/appointments/a3/cancel", office.token, { reason: "Patient unwell" })).data.outcome, "call-list");
  await call("PUT", "/api/settings", office.token, { mode: "offer" });
  const sms = (await call("POST", "/api/appointments/a5/cancel", office.token, { reason: "Patient unwell" })).data;
  assert.match(sms.offers[0].body, /it's Home Visiting Optics\./);
  // The old login doesn't work in the branded demo.
  assert.strictEqual((await call("POST", "/api/auth/password", null, { sandbox: office.sandbox, email: "sarah@airevalleyeyecare.example", password: require("../server/auth").DEMO_PASSWORD })).status, 401);
});

test("route planning: a clinician's day re-ordered to drive less, applied, and patients told their new times", async () => {
  const office = await login(HVO, "hvo");
  const plan = (await call("GET", "/api/route/plan?clinician=c1&day=1", office.token)).data;
  assert.ok(plan.savedMin >= 10, `saves ${plan.savedMin} min`);
  assert.ok(plan.after.driveMin < plan.before.driveMin);
  const before = (await call("GET", "/api/state", office.token)).data;
  assert.ok(plan.planned.every((p) => (p.from < 720) === (p.start < 720)), "mornings stay mornings");

  const r = await call("POST", "/api/route/plan", office.token, { clinicianId: "c1", day: 1 });
  assert.strictEqual(r.status, 200);
  assert.ok(r.data.applied);
  const s = (await call("GET", "/api/state", office.token)).data;
  for (const p of r.data.planned) assert.strictEqual(s.appts.find((a) => a.id === p.id).start, p.start);
  const moved = r.data.planned.filter((p) => p.moved);
  for (const m of moved) assert.ok(s.messages.some((x) => x.name === m.name && /is now at/.test(x.body)), `${m.name} is texted`);
  assert.ok(s.messages.some((x) => x.kind === "diary-change" && /re-planned/.test(x.body)), "the clinician hears too");
  assert.strictEqual(s.messages.length, before.messages.length + moved.length + 1);
  assert.strictEqual((await call("GET", "/api/route/plan?clinician=c1&day=1", office.token)).data.changed, 0, "planning again changes nothing");

  const amira = await login("amira@homevisitingoptics.example", null, office.sandbox);
  assert.strictEqual((await call("GET", "/api/route/plan?clinician=c1&day=1", amira.token)).status, 403, "office only");
});

test("referral form: a referral waits for the office; accepting makes the patient and a waiting-list place", async () => {
  const office = await login(HVO, "hvo");
  const code = office.sandbox;
  const info = (await call("GET", `/api/public/${code}`)).data;
  assert.ok(info.referral.need.sight && info.areas.length === 8);
  const form = { fromKind: "family", fromName: "Gary Holt", fromPhone: "07700 900960", name: "Joan Holt", dob: "1940-03-02", addr: "3 Mill Lane", pc: "BL1",
    phone: "", eligibility: "Dementia", entitlement: ["60+", "nonsense"], need: "sight", avail: "am", urgent: false, notes: "Ring Gary first", consent: true, formMs: 45000 };
  assert.strictEqual((await call("POST", `/api/public/${code}/referrals`, null, { ...form, eligibility: "housebound" })).status, 400, "the condition, not just 'housebound'");
  assert.strictEqual((await call("POST", `/api/public/${code}/referrals`, null, { ...form, consent: false })).status, 400);
  assert.strictEqual((await call("POST", `/api/public/${code}/referrals`, null, { ...form, fromPhone: "" })).status, 400, "someone to call");
  // Spam: a bot that fills the hidden box, or posts straight away, gets "ok" but nothing is saved
  const before = (await call("GET", "/api/state", office.token)).data.referrals.length;
  assert.strictEqual((await call("POST", `/api/public/${code}/referrals`, null, { ...form, website: "http://spam.example" })).status, 200);
  assert.strictEqual((await call("POST", `/api/public/${code}/referrals`, null, { ...form, formMs: 400 })).status, 200);
  const { formMs, ...noTimer } = form;
  assert.strictEqual((await call("POST", `/api/public/${code}/referrals`, null, noTimer)).status, 200);
  assert.strictEqual((await call("GET", "/api/state", office.token)).data.referrals.length, before, "none of those were saved");
  assert.strictEqual((await call("POST", `/api/public/${code}/referrals`, null, form)).status, 200);

  let s = (await call("GET", "/api/state", office.token)).data;
  const ref = s.referrals.find((r) => r.name === "Joan Holt");
  assert.strictEqual(ref.status, "new");
  assert.deepStrictEqual(ref.entitlement, ["60+"], "unknown answers are dropped");
  assert.ok(!s.patients.some((p) => p.name === "Joan Holt"), "not a patient until accepted");
  assert.strictEqual(s.referrals.filter((r) => r.status === "new").length, 4, "three from overnight, plus this one");

  const a = await call("POST", `/api/referrals/${ref.id}/accept`, office.token, { type: "sight", prio: "soon" });
  assert.strictEqual(a.status, 200);
  assert.strictEqual(a.data.texted, true, "Gary is texted: Joan has no mobile");
  s = (await call("GET", "/api/state", office.token)).data;
  const joan = s.patients.find((p) => p.id === a.data.patientId);
  assert.strictEqual(joan.eligibility, "Dementia");
  assert.strictEqual(joan.rep, "Gary Holt, 07700 900960");
  assert.strictEqual(joan.contact, "Call");
  assert.strictEqual(joan.age, 86);
  const w = s.waitlist.find((x) => x.patientId === joan.id);
  assert.deepStrictEqual([w.type, w.prio, w.avail], ["sight", "soon", "am"]);
  assert.strictEqual((await call("POST", `/api/referrals/${ref.id}/accept`, office.token, {})).status, 409, "only once");
  assert.strictEqual((await call("POST", `/api/referrals/rf2/decline`, office.token, { reason: "Can get to the practice" })).status, 200);
  const audit = (await call("GET", "/api/debug/overview", office.token)).data.audit.filter((x) => /^referral\./.test(x.action));
  assert.ok(audit.length >= 3 && audit.every((x) => !/Joan|Holt|0770/.test(x.detail)), "no patient details in the audit log");
  const amira = await login("amira@homevisitingoptics.example", null, code);
  assert.strictEqual((await call("POST", `/api/referrals/rf1/accept`, amira.token, {})).status, 403);
});

test("a deployment can open in a practice's brand by default; ?brand=domi still gives the neutral demo", async () => {
  process.env.DEFAULT_BRAND = "hvo";
  try {
    assert.strictEqual((await call("GET", "/api/meta")).data.brand.id, "hvo", "the plain address shows the practice");
    assert.strictEqual((await call("GET", "/api/meta?brand=domi")).data.brand.id, "domi", "the marketing site's link stays neutral");
    const sb = (await call("POST", "/api/demo/start", null, {})).data.sandbox;
    const pw = await call("POST", "/api/auth/password", null, { sandbox: sb, email: HVO, password: require("../server/auth").DEMO_PASSWORD });
    assert.strictEqual(pw.status, 200, "a demo started without a brand is the practice's");
  } finally { delete process.env.DEFAULT_BRAND; }
  assert.strictEqual((await call("GET", "/api/meta")).data.brand.id, "domi");
});
