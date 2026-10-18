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

test("the recall line: no NHS sight test before the recall date less a month, unless it's an early retest", async () => {
  const svc = require("../server/service");
  // Their own example: seen 15 Oct 2025 on a 12-month recall, no sooner than 16 Sep 2026.
  assert.strictEqual(svc.nhsFrom({ lastTest: "2025-10-15" }).iso, "2026-09-16");
  assert.strictEqual(svc.nhsFrom({ lastTest: "2026-04-10", recallMonths: 6 }).iso, "2026-09-11");
  assert.strictEqual(svc.nhsFrom({ lastTest: "2025-12-31", recallMonths: 3 }).iso, "2026-03-01", "end of a short month");
  assert.strictEqual(svc.nhsFrom({}), null);

  const o = await office();
  // p9 had a sight test on 20 Nov 2025: not before 21 Oct 2026 (day 9).
  const put = await call("PUT", "/api/patients/p9", o.token, { lastTest: "2025-11-20", recallMonths: 12 });
  assert.strictEqual(put.status, 200, JSON.stringify(put.data));
  assert.deepStrictEqual(put.data.changed, ["last sight test"], "12 is the default, so only the date changed");
  const rec = (await call("GET", "/api/patients/p9", o.token)).data;
  assert.strictEqual((rec.patient || rec).nhsFrom.iso, "2026-10-21");

  const found = (await call("POST", "/api/slots", o.token, { patientId: "p9", type: "sight", avail: "any" })).data;
  assert.strictEqual(found.recallLine.label, "21 Oct 2026");
  assert.ok(found.slots.length && found.slots.every((s) => s.day >= 9), "times start from the line");
  // A private examination isn't held back.
  assert.ok((await call("POST", "/api/slots", o.token, { patientId: "p9", type: "exam", avail: "any" })).data.slots.some((s) => s.day < 9));

  const early = (await call("POST", "/api/slots", o.token, { patientId: "p9", type: "sight", avail: "any", early: true })).data;
  assert.strictEqual(early.recallLine, null);
  const x = early.slots.find((s) => s.day < 9);
  const refused = await call("POST", "/api/bookings", o.token, { patientId: "p9", type: "sight", avail: "any", clinicianId: x.clinicianId, day: x.day, start: x.start });
  assert.strictEqual(refused.status, 409);
  assert.match(refused.data.error, /before 21 Oct 2026.*early retest/);
  const ok = await call("POST", "/api/bookings", o.token, { patientId: "p9", type: "sight", avail: "any", clinicianId: x.clinicianId, day: x.day, start: x.start, early: true });
  assert.strictEqual(ok.status, 200, JSON.stringify(ok.data));

  // Validation.
  assert.strictEqual((await call("PUT", "/api/patients/p5", o.token, { recallMonths: 9 })).status, 400);
  assert.strictEqual((await call("PUT", "/api/patients/p5", o.token, { lastTest: "2030-01-01" })).status, 400);
});

test("the recall line also keeps cancelled NHS visits from being offered to someone not yet due", () => {
  const { rankCandidates } = require("../server/refill");
  const clinician = { id: "c1", first: "Amira", optom: true, patch: ["LS6"], near: [], hours: [[540, 1050], [540, 1050], [540, 1050], [540, 1050], [540, 1050]] };
  const slot = { id: "s", clinicianId: "c1", day: 3, start: 600, type: "sight" };
  const waitlist = [{ id: "w1", patientId: "p1", type: "sight", prio: "routine", status: "waiting", avail: "any", days: 10, shortNotice: true }];
  const patientsById = { p1: { id: "p1", name: "Joan", pc: "LS6 1AA", nhsFrom: { day: 20, label: "1 Nov 2026" } } };
  const [c] = rankCandidates({ slot, clinician, dayAppts: [slot], waitlist, patientsById, sameDay: false }).candidates;
  assert.strictEqual(c.ok, false);
  assert.match(c.reason, /not due until 1 Nov 2026/);
});

test("true count: where a booking came from, how likely it is to go ahead, and each clinic's strength", async () => {
  const o = await office();
  const meta = (await call("GET", "/api/meta")).data;
  assert.strictEqual(meta.sources.recall.count, 1);
  assert.strictEqual(meta.sources.facebook.count, 0.5);
  let st = (await call("GET", "/api/state", o.token)).data;
  assert.ok(st.appts.every((a) => a.source && typeof a.count === "number"));
  assert.ok(st.appts.some((a) => a.source === "recall" && a.count === 1) && st.appts.some((a) => a.count === 0.5) && st.appts.some((a) => a.count === 0.25));
  assert.strictEqual(st.settings.clinicTarget, 10);

  // A booking for someone on the recall list counts 1; a new patient 0.5; the office can say otherwise.
  const recallPid = st.waitlist.find((w) => w.source === "recall" && w.status === "waiting").patientId;
  const s1 = (await call("POST", "/api/slots", o.token, { patientId: recallPid, type: "exam", avail: "any", date: "2026-11-02" })).data.slots[0];
  const b1 = (await call("POST", "/api/bookings", o.token, { patientId: recallPid, type: "exam", avail: "any", clinicianId: s1.clinicianId, day: s1.day, start: s1.start })).data;
  const s2 = (await call("POST", "/api/slots", o.token, { patientId: "new", name: "Ruth Ingham", pc: "LS16", addr: "3 Holt Lane", type: "repair", avail: "any", date: "2026-11-03" })).data.slots[0];
  const b2 = (await call("POST", "/api/bookings", o.token, { patientId: "new", name: "Ruth Ingham", pc: "LS16", addr: "3 Holt Lane", type: "repair", avail: "any", clinicianId: s2.clinicianId, day: s2.day, start: s2.start, source: "facebook" })).data;
  st = (await call("GET", "/api/state", o.token)).data;
  const v1 = st.appts.find((a) => a.id === b1.appointmentId), v2 = st.appts.find((a) => a.id === b2.appointmentId);
  assert.strictEqual(v1.source, "recall"); assert.strictEqual(v1.count, 1);
  assert.strictEqual(v2.source, "facebook"); assert.strictEqual(v2.count, 0.5);

  const low = await call("PUT", `/api/appointments/${v1.id}/likelihood`, o.token, { reliability: 0.25 });
  assert.strictEqual(low.status, 200, JSON.stringify(low.data));
  assert.strictEqual((await call("GET", "/api/state", o.token)).data.appts.find((a) => a.id === v1.id).count, 0.25);
  assert.strictEqual((await call("PUT", `/api/appointments/${v1.id}/likelihood`, o.token, { reliability: 0.6 })).status, 400);
  assert.strictEqual((await call("PUT", `/api/appointments/${v1.id}/likelihood`, o.token, { source: "magic" })).status, 400);
  assert.strictEqual((await call("PUT", "/api/settings", o.token, { clinicTarget: 12 })).status, 200);
  assert.strictEqual((await call("PUT", "/api/settings", o.token, { clinicTarget: 0 })).status, 400);
  const amira = await signIn("amira@airevalleyeyecare.example", o.sandbox);
  assert.strictEqual((await call("PUT", `/api/appointments/${v1.id}/likelihood`, amira.token, { reliability: 1 })).status, 403);
});

test("a director: a clinician with office access gets the office, and can switch to their own round", async () => {
  const o = await office();
  const amira = (await call("GET", "/api/team", o.token)).data.clinicians.find((c) => c.id === "c1");
  const before = await signIn("amira@airevalleyeyecare.example", o.sandbox);
  assert.strictEqual((await call("GET", "/api/team", before.token)).status, 403, "a clinician can't open the team");

  assert.strictEqual((await call("POST", "/api/team/clinicians", o.token, { ...amira, office: true })).status, 200);
  assert.strictEqual((await call("GET", "/api/team", o.token)).data.clinicians.find((c) => c.id === "c1").office, true);
  const a = await signIn("amira@airevalleyeyecare.example", o.sandbox);
  const raw = await call("GET", "/api/state", a.token);
  assert.strictEqual(raw.status, 200, JSON.stringify(raw.data).slice(0, 300) + " signin:" + JSON.stringify(a));
  let st = raw.data;
  assert.strictEqual(st.user.role, "admin"); assert.strictEqual(st.signedInAs.dual, true);
  assert.strictEqual(st.user.clinicianId, "c1", "still her own clinician record");
  assert.strictEqual((await call("GET", "/api/team", a.token)).status, 200, "office pages open");
  assert.ok(st.clinicians.length > 1, "sees every diary");

  // Her own round, as her phone shows it.
  assert.strictEqual((await call("POST", "/api/auth/view-as", a.token, { userId: a.user.id, as: "clinician" })).status, 200);
  st = (await call("GET", "/api/state", a.token)).data;
  assert.strictEqual(st.user.role, "clinician"); assert.strictEqual(st.clinicians.length, 1); assert.strictEqual(st.clinicians[0].id, "c1");
  // And back to the office.
  await call("POST", "/api/auth/view-as", a.token, { userId: a.user.id, as: "office" });
  assert.strictEqual((await call("GET", "/api/state", a.token)).data.user.role, "admin");

  // Taking office access away works at once, on the session she already has.
  await call("POST", "/api/team/clinicians", o.token, { ...amira, office: false });
  assert.strictEqual((await call("GET", "/api/state", a.token)).data.user.role, "clinician");
  assert.strictEqual((await call("GET", "/api/team", a.token)).status, 403);
  // A plain clinician asking for the office view gets nothing new.
  assert.strictEqual((await call("POST", "/api/auth/view-as", a.token, { userId: a.user.id, as: "office" })).status, 403);
});

test("Opticabase: its export imports with the ID, the home-visit reason, the next exam and a valid NHS number", async () => {
  const importer = require("../server/importer");
  const csv = [
    "ID,Title,Last Name,Name,DOB,Address,Post code,Phone,Mobile,E-Mail,NHS Reason,Domi Reason,NHS No,Last Exam,Next Exam,Optometrist",
    "30111,Mrs,Whittle,Joan,14/03/1938,12 Weetwood Lane,LS16 5NX,0113 555 0123,07700 900401,,60+,Dementia: can't go out alone,9990001111,20/11/2025,20/11/2026,Amira Shah",
    "30112,Mr,Ashworth,Frank,02/07/1941,3 Otley Road,LS6 4DH,0113 555 0124,,,60+,After a stroke: uses a wheelchair,9990002222,05/04/2026,05/10/2026,Amira Shah",
  ].join("\n");
  const r = importer.check(csv);
  const m = Object.fromEntries(r.headers.map((h, i) => [h, r.mapping[i]]));
  assert.strictEqual(m.ID, "obId"); assert.strictEqual(m["Last Name"], "last"); assert.strictEqual(m.Name, "first");
  assert.strictEqual(m.Mobile, "phone", "the mobile is the number to text"); assert.strictEqual(m.Phone, "phone2");
  assert.strictEqual(m["Domi Reason"], "eligibility"); assert.notStrictEqual(m["NHS Reason"], "eligibility");
  assert.strictEqual(m["Last Exam"], "lastTest"); assert.strictEqual(m["Next Exam"], "nextExam");
  assert.strictEqual(m["NHS No"], "nhsNo", "PCSE's notification and the GOS6 claim need it");
  const [joan, frank] = r.rows;
  assert.strictEqual(joan.patient.name, "Joan Whittle");
  assert.strictEqual(joan.patient.obId, "30111");
  assert.strictEqual(joan.patient.phone.replace(/\s/g, ""), "07700900401");
  assert.strictEqual(joan.patient.nextExam, "2026-11-20");
  assert.strictEqual(frank.patient.contact, "Call", "landline only: phoned");
  assert.strictEqual(joan.patient.nhsNo, "9990001111");
  assert.strictEqual(frank.patient.nhsNo, null, "a wrong check digit is left out");
  assert.ok(frank.warnings.some((w) => /NHS number/.test(w)));

  // Through the app: imported, then the recall line comes from Opticabase's next exam.
  const o = await office();
  const pre = await call("POST", "/api/import/preview", o.token, { csv });
  assert.strictEqual(pre.status, 200, JSON.stringify(pre.data).slice(0, 200));
  const done = await call("POST", "/api/import/commit", o.token, { csv });
  assert.strictEqual(done.status, 200, JSON.stringify(done.data).slice(0, 200));
  const st = (await call("GET", "/api/state", o.token)).data;
  const j = st.patients.find((p) => p.obId === "30111");
  assert.ok(j, "imported with the Opticabase ID");
  const rec = (await call("GET", `/api/patients/${j.id}`, o.token)).data;
  assert.strictEqual((rec.patient || rec).nhsFrom.iso, "2026-10-21", "a month before the next exam, plus a day");
  // Importing the same export again finds them by their ID.
  const again = await call("POST", "/api/import/preview", o.token, { csv });
  assert.ok(again.data.rows.every((x) => x.status === "duplicate"));
  // The ID is unique within the practice.
  assert.strictEqual((await call("PUT", "/api/patients/p5", o.token, { obId: "30111" })).status, 409);
});

test("Facebook leads: their form's street address and date of birth are kept, and a postcode is found in the address", async () => {
  const leads = require("../server/leads");
  assert.strictEqual(leads.dobOf("1942-04-03"), "1942-04-03");
  assert.strictEqual(leads.dobOf("03/04/1942"), "1942-04-03", "UK order when it fits both");
  assert.strictEqual(leads.dobOf("12/31/1950"), "1950-12-31", "US order when only that makes sense");
  assert.strictEqual(leads.dobOf("31/02/1950"), null);
  // HVO's form: full name, email, phone, street address, date of birth. No postcode question.
  const a = leads.normalise({ field_data: [
    { name: "full_name", values: ["Joan Whittle"] }, { name: "email", values: ["joan@example.com"] }, { name: "phone_number", values: ["+447700900401"] },
    { name: "street_address", values: ["12 Oak Road, Bolton BL1 4AB"] }, { name: "date_of_birth", values: ["1938-03-14"] }] });
  assert.strictEqual(a.addr, "12 Oak Road, Bolton BL1 4AB");
  assert.strictEqual(a.pc, "BL1 4AB"); assert.strictEqual(a.pcFrom, "address");
  assert.strictEqual(a.dob, "1938-03-14");
  assert.deepStrictEqual(a.answers, [], "nothing left over as a stray question");
  const b = leads.normalise({ full_name: "Frank Ashworth", phone_number: "07700 900402", street_address: "3 Mill Lane" });
  assert.strictEqual(b.pc, null); assert.strictEqual(b.pcFrom, null);

  const o = await office();
  // Through the practice's test ad form (no key needed in the demo).
  const r = await call("POST", `/api/public/${o.sandbox}/leads`, null, { full_name: "Joan Whittle", phone_number: "07700 900401", email: "joan@example.com", street_address: "12 Weetwood Lane, Leeds LS16 5NX", date_of_birth: "14/03/1938", website: "", formMs: 9000 });
  assert.ok([200, 201].includes(r.status), JSON.stringify(r.data));
  const lead = (await call("GET", "/api/state", o.token)).data.leads.find((l) => l.name === "Joan Whittle");
  assert.strictEqual(lead.addr, "12 Weetwood Lane, Leeds LS16 5NX");
  assert.strictEqual(lead.pc, "LS16 5NX"); assert.strictEqual(lead.pcFrom, "address"); assert.strictEqual(lead.dob, "1938-03-14");
});
