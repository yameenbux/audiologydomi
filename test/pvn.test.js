"use strict";
process.env.ROUTING_PROVIDER = "estimate";
// GOS6 pre-visit notifications: the notice each NHS sight test needs (48 working hours for 1 or 2 at an address,
// 3 weeks for 3 or more, never more than 8 weeks ahead), the office's list with PCSE Online's form data, and
// bookings refused when they can't meet it, unless the office records the ICB's approval.
const test = require("node:test");
const assert = require("node:assert");
const { start, server } = require("../server/index");
const auth = require("../server/auth");
const pvn = require("../server/pvn");

let base;
test.before(async () => { const s = await start(0); base = `http://127.0.0.1:${s.address().port}`; });
test.after(() => server.close());
async function call(method, path, cookie, body) {
  const res = await fetch(base + path, { method, headers: { "Content-Type": "application/json", "X-Domi": "1", ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json() };
}
async function signIn(email, sandboxId) {
  if (!sandboxId) sandboxId = (await call("POST", "/api/demo/start")).data.sandbox;
  const pw = await call("POST", "/api/auth/password", null, { sandbox: sandboxId, email, password: auth.DEMO_PASSWORD });
  const code = (await call("GET", "/api/auth/demo-code?challenge=" + encodeURIComponent(pw.data.challenge))).data.code;
  const res = await fetch(base + "/api/auth/code", { method: "POST", headers: { "Content-Type": "application/json", "X-Domi": "1" }, body: JSON.stringify({ challenge: pw.data.challenge, code }) });
  return { token: (res.headers.get("set-cookie") || "").split(";")[0], sandbox: sandboxId };
}
const office = () => signIn("sarah@airevalleyeyecare.example");
const resident = (o, name, extra) => call("POST", "/api/patients", o.token, { name, addr: "8 Lodge Road", pc: "LS6 4FH", phone: "07700 900321", contact: "Call", ...extra });

test("the rule: 48 hours for one or two at an address, 3 weeks for three or more, except sheltered housing", () => {
  assert.strictEqual(pvn.requirement(1, "home").rule, "48 hours");
  assert.strictEqual(pvn.requirement(2, "nursing").rule, "48 hours");
  assert.strictEqual(pvn.requirement(3, "nursing").rule, "3 weeks");
  assert.strictEqual(pvn.requirement(5, "sheltered").rule, "48 hours", "each flat is its own address");
  // Residents of one care home are one address, whatever their room; people at home are grouped by their address.
  assert.strictEqual(pvn.venueKey({ premises: "nursing", venue: "Oak Lodge", addr: "Room 4", pc: "LS6 4FH" }), pvn.venueKey({ premises: "nursing", venue: "oak lodge", addr: "Room 9", pc: "ls64fh" }));
  assert.notStrictEqual(pvn.venueKey({ addr: "1 High St", pc: "LS6 4FH" }), pvn.venueKey({ addr: "3 High St", pc: "LS6 4FH" }));
});

test("the office's list: at risk, to lodge, too early and notified, with what PCSE Online's form asks for", async () => {
  const o = await office();
  const d = (await call("GET", "/api/pvn", o.token)).data;
  assert.deepStrictEqual({ breach: d.counts.breach, todo: d.counts.todo, early: d.counts.early }, { breach: 1, todo: 1, early: 1 });
  assert.ok(d.counts.notified > 5);
  const home = d.visits.find((v) => v.status === "todo");
  assert.strictEqual(home.size, 3); assert.strictEqual(home.rule, "3 weeks");
  assert.strictEqual(home.lodgeBy, "Thu 15 Oct 10:00", "3 weeks before Thursday 5 November");
  const f = home.form;
  assert.strictEqual(f.dateOfVisit, "05/11/2026"); assert.strictEqual(f.approxTime, "10:00");
  assert.strictEqual(f.premisesType, "Nursing Home"); assert.strictEqual(f.contactName, "Duty manager, Moorside Court");
  assert.match(f.address, /^Moorside Court Nursing Home, 2 Moor Lane/);
  assert.deepStrictEqual(f.patients.map((p) => p.surname), ["Marsden", "Briggs", "Sutcliffe"]);
  assert.strictEqual(f.patients[0].dob, "09/03/1934"); assert.match(f.patients[0].nhsNumber, /^999\d{7}$/);
  assert.strictEqual(f.patients[1].firstTest, "First test or unknown");
  const early = d.visits.find((v) => v.status === "early");
  assert.match(early.lodgeFrom, /^Tue 27 Oct/, "8 weeks before Tuesday 22 December");
  assert.match(d.visits.find((v) => v.status === "breach").why, /ICB/);
  // The notified ones carry PCSE's reference, for the GOS6 claim.
  assert.ok(d.visits.filter((v) => v.status === "notified").every((v) => /^PVN\d+$/.test(v.refs[0])));
  // Office only: the clinician's phone just shows whether one was lodged.
  const amira = await signIn("amira@airevalleyeyecare.example", o.sandbox);
  assert.strictEqual((await call("GET", "/api/pvn", amira.token)).status, 403);
});

test("lodging records PCSE's reference; early retest codes come from PCSE's list", async () => {
  const o = await office();
  assert.strictEqual((await call("POST", "/api/pvn/lodge", o.token, { apptIds: ["mc1", "mc2", "mc3"], ref: "x" })).status, 400);
  assert.strictEqual((await call("PUT", "/api/appointments/mc1/pvn", o.token, { ert: "9" })).status, 400);
  assert.strictEqual((await call("PUT", "/api/appointments/mc1/pvn", o.token, { ert: "3.1" })).status, 200);
  assert.strictEqual((await call("POST", "/api/pvn/lodge", o.token, { apptIds: ["mc1", "mc2", "mc3"], ref: "PVN-778812" })).status, 200);
  const d = (await call("GET", "/api/pvn", o.token)).data;
  const v = d.visits.find((x) => x.form.premisesType === "Nursing Home");
  assert.strictEqual(v.status, "notified"); assert.deepStrictEqual(v.refs, ["PVN-778812"]);
  assert.strictEqual(v.form.patients[0].ertCode, "3.1");
  assert.strictEqual(d.counts.todo, 0);
});

test("a booking inside 48 working hours is refused, unless the ICB approved it", async () => {
  const o = await office();
  const plain = (await call("POST", "/api/slots", o.token, { patientId: "p9", type: "sight", avail: "any" })).data.slots;
  const approved = (await call("POST", "/api/slots", o.token, { patientId: "p9", type: "sight", avail: "any", icb: "Jo Bloggs, ICB" })).data.slots;
  const soon = approved.find((s) => !plain.some((x) => x.day === s.day && x.start === s.start && x.clinicianId === s.clinicianId));
  assert.ok(soon && soon.day <= 2, "the ICB's approval opens up the next two days");
  const body = { patientId: "p9", type: "sight", avail: "any", clinicianId: soon.clinicianId, day: soon.day, start: soon.start };
  const no = await call("POST", "/api/bookings", o.token, body);
  assert.strictEqual(no.status, 409); assert.match(no.data.error, /48 hours' notice.*ICB/);
  const ok = await call("POST", "/api/bookings", o.token, { ...body, icb: "Jo Bloggs, ICB" });
  assert.strictEqual(ok.status, 200, JSON.stringify(ok.data));
  const d = (await call("GET", "/api/pvn", o.token)).data;
  const v = d.visits.find((x) => x.lodged.some((m) => m.id === ok.data.appointmentId));
  assert.strictEqual(v.icb, "Jo Bloggs, ICB"); assert.strictEqual(v.form.icbApproval, "Jo Bloggs, ICB");
});

test("a third NHS sight test at one care home that day needs 3 weeks' notice; sheltered flats don't", async () => {
  const o = await office();
  const book = async (patientId, icb) => {
    const slots = (await call("POST", "/api/slots", o.token, { patientId, type: "sight", avail: "any", date: "2026-10-22" })).data.slots;
    const s = slots.find((x) => x.day === 10);
    assert.ok(s, "a slot on Thursday 22 October");
    return call("POST", "/api/bookings", o.token, { patientId, type: "sight", avail: "any", clinicianId: s.clinicianId, day: s.day, start: s.start, icb });
  };
  const ids = [];
  for (const n of ["Ann Oak", "Bill Oak", "Cath Oak"]) ids.push((await resident(o, n, { premises: "residential", venue: "Oak Lodge", venueContact: "Reception" })).data.patient.id);
  assert.strictEqual((await book(ids[0])).status, 200);
  assert.strictEqual((await book(ids[1])).status, 200);
  const third = await book(ids[2]);
  assert.strictEqual(third.status, 409); assert.match(third.data.error, /number 3 at Oak Lodge.*3 weeks/);
  assert.strictEqual((await book(ids[2], "Jo Bloggs, ICB")).status, 200, "with the ICB's approval");

  const flats = [];
  for (const n of ["Dan Flat", "Eve Flat", "Fay Flat"]) flats.push((await resident(o, n, { addr: "Rose Court", premises: "sheltered" })).data.patient.id);
  for (const id of flats) assert.strictEqual((await book(id)).status, 200);
});

test("moving: the new time must meet its notice, and a notified visit can't move within 48 hours of it", async () => {
  const o = await office();
  const st = (await call("GET", "/api/state", o.token)).data;
  const a = st.appts.find((x) => x.type === "sight" && x.day === 3 && x.status === "booked");
  const opts = (await call("POST", `/api/appointments/${a.id}/move-options`, o.token, { icb: "Jo Bloggs, ICB" })).data.slots;
  const near = opts.find((s) => s.day <= 1);
  assert.ok(near, "a time tomorrow, with the ICB's approval");
  const no = await call("POST", `/api/appointments/${a.id}/move`, o.token, { clinicianId: near.clinicianId, day: near.day, start: near.start });
  assert.strictEqual(no.status, 409);
  assert.strictEqual((await call("POST", `/api/appointments/${a.id}/move`, o.token, { clinicianId: near.clinicianId, day: near.day, start: near.start, icb: "Jo Bloggs, ICB" })).status, 200);
});

test("NHS numbers: the check digit is checked, and no two patients share one", async () => {
  const o = await office();
  assert.strictEqual((await call("PUT", "/api/patients/p5", o.token, { nhsNo: "999 000 2222" })).status, 400);
  assert.strictEqual((await call("PUT", "/api/patients/p5", o.token, { nhsNo: "999 000 1111" })).status, 200);
  assert.strictEqual((await call("PUT", "/api/patients/p6", o.token, { nhsNo: "9990001111" })).status, 409);
  assert.strictEqual((await call("PUT", "/api/patients/p5", o.token, { premises: "castle" })).status, 400);
});
