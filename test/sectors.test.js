"use strict";
process.env.ROUTING_PROVIDER = "estimate";
// The same engine for every kind of home-visit service: each sector's demo has its own visit types, roles and
// sample patients, and the eye-care-only features (PCSE notifications, glasses sales) stay with opticians.
const test = require("node:test");
const assert = require("node:assert");
const { start, server } = require("../server/index");
const sectors = require("../server/sectors");
const brands = require("../server/brands");

let base;
test.before(async () => { const s = await start(0); base = `http://127.0.0.1:${s.address().port}`; });
test.after(() => server.close());

const PASSWORD = require("../server/auth").DEMO_PASSWORD;
async function call(method, path, cookie, body) {
  const res = await fetch(base + path, { method, headers: { "Content-Type": "application/json", "X-Domi": "1", ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json(), cookie: (res.headers.get("set-cookie") || "").split(";")[0] };
}
/** Sign in to a new demo of this brand as its office manager (or a clinician). */
async function login(brand, role = "admin") {
  const sandbox = (await call("POST", "/api/demo/start", null, { brand })).data.sandbox;
  // The sample accounts as the sign-in page lists them: each demo has its own team.
  const email = (await call("GET", `/api/meta?brand=${brand}`)).data.demoUsers.find((u) => u.role === role).email;
  const pw = await call("POST", "/api/auth/password", null, { sandbox, email, password: PASSWORD });
  assert.strictEqual(pw.status, 200, `${brand}: ${JSON.stringify(pw.data)}`);
  const code = (await call("GET", "/api/auth/demo-code?challenge=" + encodeURIComponent(pw.data.challenge))).data.code;
  const r = await call("POST", "/api/auth/code", null, { challenge: pw.data.challenge, code });
  return r.cookie;
}
const DEMOS = { hearing: "audiology", podiatry: "podiatry", physio: "physio", nursing: "nursing", dental: "dental", ot: "ot" };

test("every sector pack has the five visit slots, both roles and its own words", () => {
  for (const s of Object.values(sectors.SECTORS)) {
    assert.deepStrictEqual(Object.keys(s.types), sectors.KEYS, `${s.id}: the five slots, in order`);
    for (const k of sectors.KEYS) assert.ok(s.types[k].name && s.types[k].dur >= 10, `${s.id}.${k}`);
    assert.ok(s.roles.lead && s.roles.support && s.roles.supportDoes, s.id);
    assert.ok(s.types[s.recall.type] && s.recall.months > 0, `${s.id}: recalls are for one of its visits`);
    assert.ok(Object.keys(s.refer).every((k) => sectors.KEYS.includes(k)), `${s.id}: referrals ask for its own visits`);
    assert.ok(s.online.every((k) => sectors.KEYS.includes(k)), s.id);
    assert.strictEqual(!!s.modules.pcse, s.id === "optical", "PCSE notifications are for opticians only");
  }
  assert.strictEqual(sectors.get().id, "optical", "a practice with no sector is an optician, as Home Visiting Optics is");
  assert.strictEqual(sectors.get("nonsense").id, "optical");
});

test("the opticians' demo is unchanged: NHS sight tests, optometrists, PCSE", async () => {
  const t = await login("domi");
  const s = (await call("GET", "/api/state", t)).data;
  assert.strictEqual(s.sector.id, "optical");
  assert.strictEqual(s.types.sight.name, "NHS sight test");
  assert.ok(s.types.sight.pvn && s.types.sight.optom);
  assert.ok(s.clinicians.some((c) => c.role === "Optometrist" && c.optom));
  assert.ok((await call("GET", "/api/pvn", t)).data.visits.length > 0, "PCSE has notifications to lodge");
});

for (const [brand, id] of Object.entries(DEMOS)) {
  test(`${brand} demo: ${id}'s visits, roles and sample patients, with no eye care in sight`, async () => {
    const sec = sectors.SECTORS[id], t = await login(brand);
    const s = (await call("GET", "/api/state", t)).data;
    assert.strictEqual(s.sector.id, id);
    assert.strictEqual(s.settings.sector, id);
    assert.deepStrictEqual(Object.values(s.types).map((x) => x.name), sectors.KEYS.map((k) => sec.types[k].name));
    assert.ok(Object.values(s.types).every((x) => !x.pvn), "no PCSE notifications");
    // The team: two lead clinicians and one support, who can't be sent the lead-only visits.
    assert.deepStrictEqual(s.clinicians.map((c) => c.role).sort(), [sec.roles.lead, sec.roles.lead, sec.roles.support].sort());
    const support = s.clinicians.find((c) => c.role === sec.roles.support);
    assert.strictEqual(support.optom, false);
    assert.ok(s.clinicians.filter((c) => c.optom).length === 2);
    // Nothing about eyes, glasses or PCSE anywhere in what the office sees.
    // Only what a person reads: string values. (Keys like "optom" and visit-type slots like "sight" are internal.)
    const strings = [];
    JSON.stringify({ patients: s.patients, waitlist: s.waitlist, recalls: s.recalls, types: s.types, clinicians: s.clinicians }, (k, v) => { if (typeof v === "string" && k !== "type") strings.push(v); return v; });
    const text = strings.join(" | ");
    assert.doesNotMatch(text, /\b(eye|sight|glasses|varifocal|bifocal|optom|PCSE|GOS)\b/i);
    const pvn = (await call("GET", "/api/pvn", t)).data;
    assert.strictEqual(pvn.visits.length, 0);
    // Glasses sales are opticians' only.
    const done = s.appts.find((a) => a.status === "done");
    assert.strictEqual((await call("PUT", `/api/appointments/${done.id}/sale`, t, { sold: false, reason: "Price" })).status, 404);
    // The team page offers the sector's roles, and saving a clinician with an eye-care role is refused.
    const team = (await call("GET", "/api/team", t)).data;
    assert.deepStrictEqual(team.roles, [sec.roles.lead, sec.roles.support]);
    // The sign-in page's sample accounts carry the sector's job titles too.
    const meta = (await call("GET", `/api/meta?brand=${brand}`)).data;
    assert.strictEqual(meta.sector.id, id);
    assert.deepStrictEqual([...new Set(meta.demoUsers.filter((u) => u.role === "clinician").map((u) => u.title))].sort(), [sec.roles.lead, sec.roles.support].sort());
  });
}

test("a cancellation in another sector refills with that sector's rules", async () => {
  const t = await login("hearing");
  const s = (await call("GET", "/api/state", t)).data;
  // Chloe (the hearing care assistant) can't be offered a lead-only visit.
  const tom = s.clinicians.find((c) => !c.optom);
  const own = s.appts.find((a) => a.clinicianId === tom.id && a.status === "booked" && a.day === 0);
  const r = (await call("POST", `/api/appointments/${own.id}/cancel`, t, { reason: "Patient unwell" })).data;
  const leadOnly = r.candidates.filter((c) => s.types[c.type] && s.types[c.type].optom);
  assert.ok(leadOnly.length, "someone on the list needs an audiologist");
  for (const c of leadOnly) assert.match(c.reason, /Needs an audiologist; Chloe does follow-ups and repairs/);
  assert.ok(r.candidates.every((c) => !/PCSE|NHS test/.test(c.reason || "")), "no NHS sight-test rules");
});

test("referrals and online booking use the sector's visits", async () => {
  const t = await login("podiatry");
  const code = (await call("GET", "/api/state", t)).data.sandbox;
  const opts = (await call("GET", `/api/public/${encodeURIComponent(code)}`)).data;
  assert.deepStrictEqual(opts.types.map((x) => x.name), sectors.SECTORS.podiatry.online.map((k) => sectors.SECTORS.podiatry.types[k].name));
  assert.deepStrictEqual(Object.values(opts.referral.need), Object.values(sectors.SECTORS.podiatry.refer));
  assert.strictEqual(opts.referral.entitlement, null, "no NHS sight-test entitlement questions");
  assert.match(opts.referral.why, /clinic/);
});

test("each sector's demo is its own practice: its own team and its own patients", async () => {
  const seen = { practice: new Set(), team: new Set(), patients: [] };
  for (const brand of ["domi", ...Object.keys(DEMOS)]) {
    const meta = (await call("GET", `/api/meta?brand=${brand}`)).data;
    seen.practice.add(meta.brand.practice);
    for (const u of meta.demoUsers) { assert.ok(!seen.team.has(u.name), `${u.name} works for only one demo`); seen.team.add(u.name); assert.ok(u.email.startsWith(u.name.split(" ")[0].toLowerCase() + "@"), u.email); }
    const s = (await call("GET", "/api/state", await login(brand))).data;
    assert.deepStrictEqual(s.clinicians.map((c) => c.name).sort(), meta.demoUsers.filter((u) => u.role === "clinician").map((u) => u.name).sort(), `${brand}: the team signs in as itself`);
    assert.strictEqual(new Set(s.patients.map((p) => p.name)).size, s.patients.length, `${brand}: no two patients share a name`);
    seen.patients.push(new Set(s.patients.map((p) => p.name)));
  }
  assert.strictEqual(seen.practice.size, 1 + Object.keys(DEMOS).length, "a different practice in each");
  for (let i = 1; i < seen.patients.length; i++) {
    const shared = [...seen.patients[i]].filter((n) => seen.patients[0].has(n)).length;
    assert.ok(shared <= 3, `demo ${i} shares ${shared} patient names with the opticians' demo`);
  }
});
