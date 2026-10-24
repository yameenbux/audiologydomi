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
  // The demo starts with half of tomorrow's CC3s made; the rest are today's work, and the diary marks them as due.
  const open3 = tomorrow.filter((a) => !(a.cc[3] && a.cc[3].o !== "no-answer"));
  assert.ok(open3.length > 0 && open3.length < tomorrow.length);
  assert.strictEqual(L.calls[3].length, open3.length, "every visit tomorrow without its CC3 is on the list");
  assert.ok(open3.every((a) => a.ccDue === 3), "and marked as due on the diary");
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
  assert.ok(again.data.rows.every((x) => x.status === "same"), "the same export again: everyone already up to date");
  // The ID is unique within the practice.
  assert.strictEqual((await call("PUT", "/api/patients/p5", o.token, { obId: "30111" })).status, 409);
});

test("Opticabase every morning: the same export again adds new patients, updates changed ones by ID, and never doubles anyone", async () => {
  const o = await office();
  const H = "ID,Title,Last Name,Name,DOB,Address,Post code,Phone,Mobile,E-Mail,Domi Reason,NHS No,Next Exam";
  const day1 = [H,
    "40001,Mrs,Whittle,Joan,14/03/1938,12 Weetwood Lane,LS16 5NX,,07700 900401,,Dementia: can't go out alone,9990001111,20/11/2026",
    "40002,Mr,Ashworth,Frank,02/07/1941,3 Otley Road,LS6 4DH,0113 555 0124,,,After a stroke,,05/10/2026"].join("\n");
  assert.strictEqual((await call("POST", "/api/import/commit", o.token, { csv: day1 })).data.imported, 2);
  // Next morning: Joan has moved and has a new mobile; Frank is unchanged; Ivy is new; a row reuses Frank's ID
  // for someone with a different date of birth; and Joan's row has an empty email, which must not blank anything.
  const day2 = [H,
    "40001,Mrs,Whittle,Joan,14/03/1938,4 Moor Grange View,LS16 5JQ,,07700 900499,,Dementia: can't go out alone,9990001111,20/11/2026",
    "40002,Mr,Ashworth,Frank,02/07/1941,3 Otley Road,LS6 4DH,0113 555 0124,,,After a stroke,,05/10/2026",
    "40003,Mrs,Pickles,Ivy,09/09/1936,8 Church Lane,LS27 9AB,,07700 900403,,Parkinson's,,",
    "40002,Mr,Ashworth,Francis,11/11/1950,9 Other Road,LS6 1AA,,07700 900777,,,,"].join("\n");
  const pv = (await call("POST", "/api/import/preview", o.token, { csv: day2 })).data;
  assert.deepStrictEqual(pv.rows.map((r) => r.status), ["update", "same", "ready", "conflict"]);
  assert.deepStrictEqual(pv.rows[0].changes.map((c) => c.field), ["addr", "pc", "phone"]);
  assert.strictEqual(pv.rows[0].changes[0].to, "4 Moor Grange View");
  assert.match(pv.rows[3].conflict, /born 1941-07-02/);
  assert.deepStrictEqual({ ready: pv.counts.ready, update: pv.counts.update, same: pv.counts.same, conflict: pv.counts.conflict }, { ready: 1, update: 1, same: 1, conflict: 1 });

  const done = (await call("POST", "/api/import/commit", o.token, { csv: day2 })).data;
  assert.deepStrictEqual({ imported: done.imported, updated: done.updated, same: done.same, conflicts: done.conflicts }, { imported: 1, updated: 1, same: 1, conflicts: 1 });
  const st = (await call("GET", "/api/state", o.token)).data;
  const joans = st.patients.filter((p) => p.obId === "40001");
  assert.strictEqual(joans.length, 1, "Joan once, not twice");
  assert.strictEqual(joans[0].addr, "4 Moor Grange View"); assert.strictEqual(joans[0].pc, "LS16 5JQ");
  assert.strictEqual(joans[0].phone.replace(/\s/g, ""), "07700900499");
  assert.strictEqual(joans[0].eligibility, "Dementia: can't go out alone", "an unchanged field stays");
  assert.strictEqual(st.patients.find((p) => p.obId === "40002").name, "Frank Ashworth", "the mismatched row changed nothing");
  const rec = (await call("GET", `/api/patients/${joans[0].id}`, o.token)).data;
  assert.ok(rec.history.some((n) => n.label === "Updated from Opticabase" && /address, postcode, phone/.test(n.body)));

  // A patient added in Domi by hand, without an ID, is found by phone and given their Opticabase ID: not doubled.
  const hand = (await call("POST", "/api/patients", o.token, { name: "Wilfred Oddie", addr: "22 Kirk Lane", pc: "LS6 4FH", phone: "07700 900404" })).data.patient;
  const day3 = [H, "40004,Mr,Oddie,Wilfred,,22 Kirk Lane,LS6 4FH,,07700 900404,,,,"].join("\n");
  const p3 = (await call("POST", "/api/import/preview", o.token, { csv: day3 })).data;
  assert.strictEqual(p3.rows[0].status, "update");
  assert.deepStrictEqual(p3.rows[0].changes.map((c) => c.field), ["obId"]);
  await call("POST", "/api/import/commit", o.token, { csv: day3 });
  const after = (await call("GET", "/api/state", o.token)).data.patients.filter((p) => p.name === "Wilfred Oddie");
  assert.strictEqual(after.length, 1); assert.strictEqual(after[0].id, hand.id); assert.strictEqual(after[0].obId, "40004");
});

test("phone mode: a cancellation gives the office a call list, nobody is texted, and rung patients drop off", async () => {
  const o = await office();
  assert.strictEqual((await call("PUT", "/api/settings", o.token, { mode: "phone" })).status, 200);
  const st = (await call("GET", "/api/state", o.token)).data;
  const offersBefore = st.messages.filter((m) => m.kind === "offer").length;
  const a = st.appts.find((x) => x.day === 3 && x.status === "booked");
  const r = (await call("POST", `/api/appointments/${a.id}/cancel`, o.token, { reason: "Patient unwell" })).data;
  assert.strictEqual(r.outcome, "call-list");
  const after = (await call("GET", "/api/state", o.token)).data;
  assert.strictEqual(after.messages.filter((m) => m.kind === "offer").length, offersBefore, "nobody texted an offer");

  const g = (await call("GET", `/api/gaps/${a.id}`, o.token)).data;
  assert.strictEqual(g.mode, "phone");
  const ok = g.candidates.filter((c) => c.ok);
  assert.ok(ok.length >= 2, "at least two people to ring");
  // First: no answer. Second: not interested. Both drop off this slot's list and show as rung.
  assert.strictEqual((await call("POST", `/api/gaps/${a.id}/skip`, o.token, { waitlistId: ok[0].waitlistId, outcome: "no-answer" })).status, 200);
  assert.strictEqual((await call("POST", `/api/gaps/${a.id}/skip`, o.token, { waitlistId: ok[1].waitlistId, outcome: "declined" })).status, 200);
  const g2 = (await call("GET", `/api/gaps/${a.id}`, o.token)).data;
  assert.ok(!g2.candidates.some((c) => c.waitlistId === ok[0].waitlistId || c.waitlistId === ok[1].waitlistId));
  assert.deepStrictEqual(g2.rung.map((x) => x.outcome), ["No answer", "Not interested"]);
  assert.strictEqual((await call("POST", `/api/gaps/${a.id}/skip`, o.token, { waitlistId: ok[0].waitlistId, outcome: "maybe" })).status, 400);
  // The third says yes.
  const next = g2.candidates.find((c) => c.ok);
  const b = await call("POST", `/api/gaps/${a.id}/book`, o.token, { waitlistId: next.waitlistId });
  assert.strictEqual(b.status, 200, JSON.stringify(b.data));
  assert.strictEqual(b.data.start, a.start);
});

test("phone mode: an NHS sight test can't be offered a slot inside PCSE's notice; repairs and deliveries can", async () => {
  const o = await office();
  await call("PUT", "/api/settings", o.token, { mode: "phone" });
  const st = (await call("GET", "/api/state", o.token)).data;
  const a = st.appts.find((x) => x.day === 1 && x.status === "booked");
  await call("POST", `/api/appointments/${a.id}/cancel`, o.token, { reason: "Patient unwell" });
  const g = (await call("GET", `/api/gaps/${a.id}`, o.token)).data;
  const nhs = g.candidates.filter((c) => c.type === "sight");
  assert.ok(nhs.length, "someone on the list is waiting for an NHS sight test");
  assert.ok(nhs.every((c) => !c.ok && /PCSE/.test(c.reason)), "none of them can take tomorrow's slot");
  assert.ok(g.candidates.filter((c) => c.ok).every((c) => c.type !== "sight"));
});

test("pilot: the baseline and targets are saved, each week is measured from the diary, and only the office sees it", async () => {
  const o = await office();
  const empty = (await call("GET", "/api/pilot", o.token)).data;
  assert.strictEqual(empty.config.start, null); assert.deepStrictEqual(empty.weeks, []);
  // A target needs its baseline first.
  assert.strictEqual((await call("PUT", "/api/pilot", o.token, { start: "2026-10-12", baseline: {}, targets: [{ key: "milesPerVisit", pct: 10 }] })).status, 400);
  assert.strictEqual((await call("PUT", "/api/pilot", o.token, { start: "12/10/2026" })).status, 400);
  const r = await call("PUT", "/api/pilot", o.token, { start: "2026-10-12", agreedBy: "Zain, office manager",
    baseline: { milesPerVisit: 9.5, refillRate: 35, officeHours: 12 }, targets: [{ key: "milesPerVisit", pct: 10 }, { key: "officeHours", pct: 25 }, { key: "refillRate", pct: 80 }] });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  const d = r.data;
  assert.strictEqual(d.weeks.length, 1); assert.ok(d.weeks[0].inProgress, "week 1 is this week");
  assert.ok(d.weeks[0].visits > 0, "today's visits count");
  assert.strictEqual(d.weeks[0].milesPerVisit, null, "miles per visit waits for the mileage claims");
  assert.deepStrictEqual(d.targets.map((t) => [t.key, t.goal]), [["milesPerVisit", 8.6], ["officeHours", 9], ["refillRate", 80]], "refilled is a level to reach, not a % change");
  assert.strictEqual((await call("PUT", "/api/pilot", o.token, { baseline: { refillRate: 90 }, targets: [{ key: "refillRate", pct: 80 }] })).status, 400, "a target below the baseline");
  assert.strictEqual((await call("PUT", "/api/pilot", o.token, { baseline: { refillRate: 135 } })).status, 400, "a share can't pass 100%");
  assert.strictEqual(d.status, "measuring", "nothing is judged on a week that isn't finished");
  // A cancellation this week shows as cancelled and left empty until someone is booked in.
  const st = (await call("GET", "/api/state", o.token)).data;
  const a = st.appts.find((x) => x.day === 2 && x.status === "booked");
  await call("POST", `/api/appointments/${a.id}/cancel`, o.token, { reason: "Patient unwell" });
  const w1 = (await call("GET", "/api/pilot", o.token)).data.weeks[0];
  assert.strictEqual(w1.cancellations, 1); assert.strictEqual(w1.unfilledPerWeek, 1); assert.strictEqual(w1.refillRate, 0); assert.strictEqual(w1.callsPerRefill, null);
  // Filled by phone: the first person didn't pick up, the second said yes. Two calls for one refill.
  const gap = (await call("GET", `/api/gaps/${a.id}`, o.token)).data;
  const first = gap.candidates.find((c) => c.ok);
  assert.strictEqual((await call("POST", `/api/gaps/${a.id}/skip`, o.token, { waitlistId: first.waitlistId, outcome: "no-answer" })).status, 200);
  const second = (await call("GET", `/api/gaps/${a.id}`, o.token)).data.candidates.find((c) => c.ok && c.waitlistId !== first.waitlistId);
  assert.strictEqual((await call("POST", `/api/gaps/${a.id}/book`, o.token, { waitlistId: second.waitlistId })).status, 200);
  const w1b = (await call("GET", "/api/pilot", o.token)).data.weeks[0];
  assert.deepStrictEqual([w1b.refilled, w1b.refillRate, w1b.unfilledPerWeek, w1b.calls, w1b.callsPerRefill], [1, 100, 0, 2, 2]);
  // The office records its own hours, and the miles on the week's mileage claims; per visit is claimed miles over visits.
  assert.strictEqual((await call("PUT", "/api/pilot/week", o.token, { week: 1, hours: "8.5" })).status, 200);
  assert.strictEqual((await call("PUT", "/api/pilot/week", o.token, { week: 1, hours: "lots" })).status, 400);
  assert.strictEqual((await call("PUT", "/api/pilot/week", o.token, { week: 1 })).status, 400);
  assert.strictEqual((await call("PUT", "/api/pilot/week", o.token, { week: 1, miles: "240" })).status, 200);
  const w = (await call("GET", "/api/pilot", o.token)).data.weeks[0];
  assert.strictEqual(w.officeHours, 8.5, "saving miles leaves the hours alone");
  assert.strictEqual(w.milesClaimed, 240); assert.strictEqual(w.milesPerVisit, Math.round((240 / w.visits) * 10) / 10);
  assert.strictEqual((await call("PUT", "/api/pilot/week", o.token, { week: 1, miles: "" })).status, 200);
  assert.strictEqual((await call("GET", "/api/pilot", o.token)).data.weeks[0].milesPerVisit, null);
  const amira = await signIn("amira@airevalleyeyecare.example", o.sandbox);
  assert.strictEqual((await call("GET", "/api/pilot", amira.token)).status, 403);
});

test("copy to Opticabase: every booking, move and cancellation is listed with the Opticabase ID, then ticked off", async () => {
  const o = await office();
  assert.deepStrictEqual((await call("GET", "/api/diary-changes", o.token)).data.todo, [], "a fresh demo has nothing to copy");
  await call("PUT", "/api/patients/p9", o.token, { obId: "51234" });
  const slot = (await call("POST", "/api/slots", o.token, { patientId: "p9", type: "repair", avail: "any", date: "2026-10-19" })).data.slots[0];
  const b = (await call("POST", "/api/bookings", o.token, { patientId: "p9", type: "repair", avail: "any", clinicianId: slot.clinicianId, day: slot.day, start: slot.start })).data;
  const opts = (await call("POST", `/api/appointments/${b.appointmentId}/move-options`, o.token, {})).data.slots;
  const to = opts.find((x) => x.day !== slot.day || x.start !== slot.start);
  assert.strictEqual((await call("POST", `/api/appointments/${b.appointmentId}/move`, o.token, { clinicianId: to.clinicianId, day: to.day, start: to.start })).status, 200);
  await call("POST", `/api/appointments/${b.appointmentId}/cancel`, o.token, { reason: "Patient asked to rebook" });
  const d = (await call("GET", "/api/diary-changes", o.token)).data;
  assert.deepStrictEqual(d.todo.map((x) => x.change), ["booked", "moved", "cancelled"]);
  assert.ok(d.todo.every((x) => x.obId === "51234"), "each carries the Opticabase ID to find them by");
  const moved = d.todo[1];
  assert.strictEqual(moved.wasDate, "2026-10-19"); assert.strictEqual(moved.wasTime, `${String(Math.floor(slot.start / 60)).padStart(2, "0")}:${String(slot.start % 60).padStart(2, "0")}`);
  assert.strictEqual(d.todo[2].reason, "Patient asked to rebook");
  assert.strictEqual((await call("GET", "/api/state", o.token)).data.diaryTodo, 3);
  assert.strictEqual((await call("POST", "/api/diary-changes/copied", o.token, { ids: [] })).status, 400);
  assert.strictEqual((await call("POST", "/api/diary-changes/copied", o.token, { ids: d.todo.map((x) => x.id) })).data.copied, 3);
  const after = (await call("GET", "/api/diary-changes", o.token)).data;
  assert.strictEqual(after.todo.length, 0); assert.strictEqual(after.done.length, 3);
  assert.ok(after.done.every((x) => x.copiedBy));
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

test("the diary's call markers: the latest outcome per call, who made it, and only 'confirmed' for clinicians", async () => {
  const o = await office();
  const st = (await call("GET", "/api/state", o.token)).data;
  const today = st.appts.filter((a) => a.day === 0 && a.status !== "cancelled");
  assert.ok(today.length && today.every((a) => [1, 2, 3].every((s) => a.cc[s] && a.cc[s].o !== "no-answer" && a.cc[s].by)), "today's visits had all three calls");
  const x = st.appts.find((a) => a.day === 1 && a.status === "booked" && a.ccDue === 3 && a.clinicianId === "c1");
  await call("POST", `/api/calls/${x.id}`, o.token, { stage: 3, outcome: "no-answer" });
  let y = (await call("GET", "/api/state", o.token)).data.appts.find((a) => a.id === x.id);
  assert.strictEqual(y.cc[3].o, "no-answer"); assert.strictEqual(y.cc[3].tries, 1); assert.strictEqual(y.ccDue, 3);
  await call("POST", `/api/calls/${x.id}`, o.token, { stage: 3, outcome: "done" });
  await call("POST", `/api/calls/${x.id}`, o.token, { stage: 3, outcome: "no-answer" });
  y = (await call("GET", "/api/state", o.token)).data.appts.find((a) => a.id === x.id);
  assert.strictEqual(y.cc[3].o, "done", "a call that was made isn't undone"); assert.strictEqual(y.ccDue, null);
  const c = await signIn("amira@airevalleyeyecare.example", o.sandbox);
  const mine = (await call("GET", "/api/state", c.token)).data.appts;
  assert.ok(mine.every((a) => a.cc === undefined && typeof a.confirmed === "boolean"), "clinicians see confirmed, not the office's call log");
  assert.strictEqual(mine.find((a) => a.id === x.id).confirmed, true);
});

test("patient availability: recorded on a visit or for good, kept by moving, booking and the route planner", async () => {
  const o = await office();
  const st = (await call("GET", "/api/state", o.token)).data;
  const a = st.appts.find((x) => x.day === 2 && x.status === "booked" && x.start < 720);
  assert.strictEqual((await call("PUT", `/api/appointments/${a.id}/availability`, o.token, { tw: "after", at: 1213 })).status, 400, "outside 07:00-20:00 on the 5 minutes");
  const r = await call("PUT", `/api/appointments/${a.id}/availability`, o.token, { tw: "pm", always: true });
  assert.strictEqual(r.status, 200); assert.strictEqual(r.data.label, "Afternoons only");
  assert.ok(r.data.outside.some((x) => x.id === a.id), "the morning visit is flagged, not moved");
  // Moving it: only afternoon times are offered, and a morning time is refused.
  const opts = (await call("POST", `/api/appointments/${a.id}/move-options`, o.token, {})).data;
  assert.ok(opts.slots && opts.slots.every((s) => s.start >= 720));
  // The route planner puts it into the afternoon.
  const plan = (await call("GET", `/api/route/plan?clinician=${a.clinicianId}&day=${a.day}`, o.token)).data;
  assert.ok(plan.planned, JSON.stringify(plan).slice(0, 200));
  assert.ok(plan.planned.find((x) => x.id === a.id).start >= 720, "planned into the afternoon");
  // A new booking for the same patient only offers afternoons, and carries the restriction.
  const s = (await call("POST", "/api/slots", o.token, { patientId: a.patientId, type: "repair", avail: "any" })).data;
  assert.ok(s.slots.length && s.slots.every((x) => x.start >= 720));
  const b = (await call("POST", "/api/bookings", o.token, { patientId: a.patientId, type: "repair", avail: "any", clinicianId: s.slots[0].clinicianId, day: s.slots[0].day, start: s.slots[0].start })).data;
  const nb = (await call("GET", "/api/state", o.token)).data.appts.find((x) => x.id === b.appointmentId);
  assert.deepStrictEqual(nb.tw, { k: "pm", at: null });
  // Back to any time.
  assert.strictEqual((await call("PUT", `/api/appointments/${a.id}/availability`, o.token, { tw: "any", always: true })).data.label, "Any time");
});

test("sales at the visit: recorded when the clinician completes it, seen by the office, listed for Opticabase", async () => {
  const o = await office();
  const amira = await signIn("amira@airevalleyeyecare.example", o.sandbox);
  // a2 is under way (live): completing it carries the sale. A bad price stops both.
  assert.strictEqual((await call("POST", "/api/appointments/a2/status", amira.token, { status: "done", sale: { sold: true, frames: "abc" } })).status, 400);
  assert.strictEqual((await call("POST", "/api/appointments/a2/status", amira.token, { status: "done", sale: { sold: true } })).status, 400, "a price is needed");
  assert.strictEqual((await call("GET", "/api/state", o.token)).data.appts.find((a) => a.id === "a2").status, "live", "still open");
  const r = await call("POST", "/api/appointments/a2/status", amira.token, { status: "done", sale: { sold: true, frames: "129.00", frameRef: "Ray-Ban RB5154", lenses: "99", lensDesc: "Varifocals", voucher: true } });
  assert.strictEqual(r.status, 200);
  const st = (await call("GET", "/api/state", o.token)).data;
  const s = st.appts.find((a) => a.id === "a2").sale;
  assert.deepStrictEqual([s.sold, s.framesPence, s.lensesPence, s.totalPence, s.voucher, s.method], [true, 12900, 9900, 22800, true, "card"]);
  assert.ok((await call("GET", "/api/state", amira.token)).data.appts.every((a) => a.sale === undefined), "clinicians don't get the office's sales figures");
  // It's on the Copy to Opticabase list, and can be ticked off.
  const d = (await call("GET", "/api/diary-changes", o.token)).data;
  const row = d.todo.find((x) => x.change === "sold" && x.appointmentId === "a2");
  assert.ok(row && /Frames £129\.00 \(Ray-Ban RB5154\); Lenses £99\.00 \(Varifocals\); NHS voucher/.test(row.reason), row && row.reason);
  assert.strictEqual((await call("POST", "/api/diary-changes/copied", o.token, { ids: [row.id] })).status, 200);
  assert.ok(!(await call("GET", "/api/diary-changes", o.token)).data.todo.some((x) => x.id === row.id));
  // The office can correct it: nothing sold, with a reason. Only on a finished visit.
  assert.strictEqual((await call("PUT", "/api/appointments/a2/sale", o.token, { sold: false, reason: "Price" })).status, 200);
  assert.strictEqual((await call("GET", "/api/state", o.token)).data.appts.find((a) => a.id === "a2").sale.reason, "Price");
  assert.strictEqual((await call("PUT", "/api/appointments/a3/sale", o.token, { sold: false, reason: "Price" })).status, 409);
  assert.strictEqual((await call("PUT", "/api/appointments/a2/sale", amira.token, { sold: false, reason: "Price" })).status, 403);
});

test("reports: any period, with visits, sales by clinician, mileage and the reasons nothing was sold", async () => {
  const o = await office();
  const amira = await signIn("amira@airevalleyeyecare.example", o.sandbox);
  await call("POST", "/api/appointments/a2/status", amira.token, { status: "done", sale: { sold: true, frames: "120", lenses: "80" } });
  const r = (await call("GET", "/api/reports?period=today", o.token)).data;
  assert.strictEqual(r.period.key, "today"); assert.strictEqual(r.period.from, 0);
  assert.ok(r.summary.visitsDone >= 4, "a1, b1, d1 and a2 are done");
  assert.strictEqual(r.finance.salesPence, 20000); assert.strictEqual(r.summary.sales, 1);
  const am = r.byClinician.find((x) => x.clinicianId === "c1");
  assert.strictEqual(am.salesPence, 20000); assert.strictEqual(am.sales, 1);
  assert.ok(r.mileage.clinicians.length >= 3 && r.mileage.clinicians.every((c) => c.miles >= 0));
  assert.ok(r.days.length === 1 && r.days[0].salesPence === 20000);
  assert.strictEqual((await call("GET", "/api/reports?period=custom&from=2026-10-20&to=2026-10-25", o.token)).status, 400, "not past today");
  assert.strictEqual((await call("GET", "/api/reports?period=custom&from=2026-10-09&to=2026-10-01", o.token)).status, 400);
  assert.strictEqual((await call("GET", "/api/reports?period=week", amira.token)).status, 403, "office only");
});

test("route modes: add to the end puts today's bookings after the last visit; text and re-plan texts the waiting list", async () => {
  const o = await office();
  assert.strictEqual((await call("PUT", "/api/settings", o.token, { routeMode: "sideways" })).status, 400);
  assert.strictEqual((await call("PUT", "/api/settings", o.token, { routeMode: "end" })).status, 200);
  const st = (await call("GET", "/api/state", o.token)).data;
  const s = (await call("POST", "/api/slots", o.token, { patientId: "p9", type: "repair", avail: "any" })).data.slots;
  const soon = s.filter((x) => x.day <= 1);
  assert.ok(soon.length, "some last-minute options");
  for (const x of soon) {
    const last = Math.max(...st.appts.filter((a) => a.clinicianId === x.clinicianId && a.day === x.day && a.status !== "cancelled").map((a) => a.start));
    assert.ok(x.start > last, `${x.clinicianId} ${x.start} after ${last}`); assert.ok(x.why.some((w) => /End of the round/.test(w)));
  }
  // Text and re-plan switches a phone-first practice to texting the waiting list.
  await call("PUT", "/api/settings", o.token, { mode: "phone" });
  assert.strictEqual((await call("PUT", "/api/settings", o.token, { routeMode: "replan" })).status, 200);
  const set = (await call("GET", "/api/state", o.token)).data.settings;
  assert.strictEqual(set.routeMode, "replan"); assert.strictEqual(set.mode, "offer");
});

test("changing the order of a round by hand: previewed first, then applied with texts to the patients moved", async () => {
  const o = await office();
  const st = (await call("GET", "/api/state", o.token)).data;
  const mine = st.appts.filter((a) => a.clinicianId === "c1" && a.day === 2 && a.status === "booked").sort((a, b) => a.start - b.start);
  const ids = mine.map((a) => a.id).reverse();
  assert.strictEqual((await call("POST", "/api/route/order", o.token, { clinicianId: "c1", day: 2, ids: ids.slice(1) })).status, 400);
  const prev = (await call("POST", "/api/route/order", o.token, { clinicianId: "c1", day: 2, ids })).data;
  assert.deepStrictEqual(prev.planned.map((x) => x.id), ids); assert.ok(prev.manual && prev.changed > 0);
  const before = (await call("GET", "/api/state", o.token)).data.messages.length;
  const done = (await call("POST", "/api/route/order", o.token, { clinicianId: "c1", day: 2, ids, apply: true })).data;
  assert.strictEqual(done.applied, true);
  const after = (await call("GET", "/api/state", o.token)).data;
  const order = after.appts.filter((a) => a.clinicianId === "c1" && a.day === 2 && a.status === "booked").sort((a, b) => a.start - b.start).map((a) => a.id);
  assert.deepStrictEqual(order, ids, "the diary follows the office's order");
  assert.ok(after.messages.length > before, "patients whose time changed are texted");
});
