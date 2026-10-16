"use strict";
process.env.ROUTING_PROVIDER = "estimate"; // the diary tests must not depend on a third-party router
// The office running everything from the admin side: editing records, moving visits, recording a visit for a
// clinician, filling a gap by phone, the family cancellation link, the team, and UK GDPR export and erasure.
const test = require("node:test");
const assert = require("node:assert");
const { start, server } = require("../server/index");

let base;
test.before(async () => { const s = await start(0); base = `http://127.0.0.1:${s.address().port}`; });
test.after(() => server.close());

const PASSWORD = require("../server/auth").DEMO_PASSWORD;
async function call(method, path, cookie, body) {
  const res = await fetch(base + path, { method, headers: { "Content-Type": "application/json", "X-Domi": "1", ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json(), cookie: (res.headers.get("set-cookie") || "").split(";")[0] };
}
async function signIn(email, sandbox) {
  if (!sandbox) sandbox = (await call("POST", "/api/demo/start")).data.sandbox;
  const pw = await call("POST", "/api/auth/password", null, { sandbox, email, password: PASSWORD });
  if (pw.status !== 200) return { status: pw.status, error: pw.data.error };
  const code = (await call("GET", "/api/auth/demo-code?challenge=" + encodeURIComponent(pw.data.challenge))).data.code;
  const r = await call("POST", "/api/auth/code", null, { challenge: pw.data.challenge, code });
  return { token: r.cookie, sandbox, user: r.data.user, status: r.status };
}
const office = (sb) => signIn("sarah@airevalleyeyecare.example", sb);
/** A new person opens their invitation, chooses a password and confirms a code from their (simulated) app. */
async function acceptInvite(invite, password = "kettle-orange-harbour") {
  const [, , code, tok] = new URL(invite.url).pathname.split("/");
  const base = `/api/public/${code}/invite/${tok}`;
  const set = await call("POST", base + "/password", null, { password });
  const a = require("../server/auth");
  const done = await call("POST", base + "/confirm", null, { code: a.hotp(a.unbase32(set.data.secret), a.stepAt()) });
  assert.strictEqual(done.status, 200, JSON.stringify(done.data));
  // Then a normal sign-in with the new password and the app's next code.
  const pw = await call("POST", "/api/auth/password", null, { sandbox: code, email: done.data.email, password });
  const r = await call("POST", "/api/auth/code", null, { challenge: pw.data.challenge, code: a.hotp(a.unbase32(set.data.secret), a.stepAt() + 1) });
  return { token: r.cookie, user: r.data.user, status: r.status };
}
const state = async (t) => (await call("GET", "/api/state", t)).data;
const texts = async (t) => (await state(t)).messages;

test("the office edits a patient's details; the clinician hears about a new address; the log names fields, not values", async () => {
  const o = await office();
  const r = await call("PUT", "/api/patients/p4", o.token, { addr: "9 Spen Lane", pc: "LS16", phone: "07700 900999", rep: "Son Dan, 07700 900998", alerts: "Ring the bell twice\n\nDog in the garden" });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.data.changed, ["address", "postcode", "phone", "next of kin or carer", "visit notes"]);
  const p = (await state(o.token)).patients.find((x) => x.id === "p4");
  assert.strictEqual(p.addr, "9 Spen Lane"); assert.strictEqual(p.phone, "07700 900999");
  assert.deepStrictEqual(p.alerts, ["Ring the bell twice", "Dog in the garden"]);
  assert.ok((await texts(o.token)).some((m) => m.toClin === "c1" && /Address change for Ken Ollerton/.test(m.body)), "Amira is told: Ken is on her round today");
  const audit = (await call("GET", "/api/debug/overview", o.token)).data.audit.find((a) => a.action === "patient.update");
  assert.match(audit.detail, /Changed address/); assert.doesNotMatch(audit.detail, /Spen|07700/);
  // Nothing changes when nothing is different, and bad input is refused with a reason
  assert.deepStrictEqual((await call("PUT", "/api/patients/p4", o.token, { phone: "07700900999" })).data.changed, []);
  assert.match((await call("PUT", "/api/patients/p4", o.token, { phone: "01132 496000" })).data.error, /Texts need a mobile/);
  assert.strictEqual((await call("PUT", "/api/patients/p4", o.token, { phone: "01132 496000", contact: "Call" })).status, 200, "a landline is fine for someone who's phoned");
  assert.match((await call("PUT", "/api/patients/p4", o.token, { eligibility: "Housebound" })).data.error, /illness or condition/);
  // An old generic reason already on the record doesn't stop other changes being saved
  require("../server/sandbox").run(require("../server/sandbox").get(o.sandbox), () => require("../server/db").db.prepare("UPDATE patients SET eligibility = 'Housebound' WHERE id = 'p4'").run());
  assert.strictEqual((await call("PUT", "/api/patients/p4", o.token, { eligibility: "Housebound", specs: "Reading glasses" })).status, 200);
  assert.strictEqual((await call("PUT", "/api/patients/p4", o.token, { pc: "ZZ99" })).status, 400);
  const amira = await signIn("amira@airevalleyeyecare.example", o.sandbox);
  assert.strictEqual((await call("PUT", "/api/patients/p4", amira.token, { name: "X" })).status, 403, "office only");
});

test("moving a visit: one text, PCSE's notification moved with it, an NHS test never inside 48 hours", async () => {
  const o = await office();
  const opts = (await call("POST", "/api/appointments/a4/move-options", o.token, {})).data; // Ken, NHS sight test, 13:30 today
  assert.ok(opts.slots.length);
  assert.ok(opts.slots.every((s) => s.day >= 2), "a sight test can only move to a time PCSE can be told about in time");
  const to = opts.slots[0];
  const r = await call("POST", "/api/appointments/a4/move", o.token, { clinicianId: to.clinicianId, day: to.day, start: to.start });
  assert.strictEqual(r.status, 200);
  const st = await state(o.token), a = st.appts.find((x) => x.id === "a4");
  assert.deepStrictEqual([a.clinicianId, a.day, a.start, a.status], [to.clinicianId, to.day, to.start, "booked"]);
  assert.deepStrictEqual(st.pcse.filter((t) => t.appointmentId === "a4").map((t) => t.action), ["cancel", "lodge"]);
  const toKen = st.messages.filter((m) => m.name === "Ken Ollerton");
  assert.strictEqual(toKen.length, 1); assert.match(toKen[0].body, /has moved to/);
  // The same time again is refused (it's no longer free), and a visit that's started can't move
  assert.strictEqual((await call("POST", "/api/appointments/a4/move", o.token, { clinicianId: "c1", day: 0, start: 13 * 60 + 30 })).status, 409);
  assert.strictEqual((await call("POST", "/api/appointments/a2/move-options", o.token, {})).status, 409, "Hilda's visit is in progress");
  // Someone who asked to be phoned isn't texted about the move
  const peter = (await call("POST", "/api/appointments/a3/move-options", o.token, {})).data.slots[0];
  const moved = (await call("POST", "/api/appointments/a3/move", o.token, { clinicianId: peter.clinicianId, day: peter.day, start: peter.start })).data;
  assert.strictEqual(moved.texted, false);
  assert.ok(!(await texts(o.token)).some((m) => m.name === "Peter Dunn"));
});

test("the office records a visit for a clinician: no 'on the way' text, the invoice is raised, a no-answer goes back on the list", async () => {
  const o = await office();
  const r = await call("POST", "/api/appointments/a2/record", o.token, { outcome: "done", note: "Arm replaced, glasses adjusted." });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.status, "done"); assert.ok(r.data.invoice, "a repair is charged");
  assert.ok(!(await texts(o.token)).some((m) => m.kind === "on-the-way"));
  assert.match((await call("GET", "/api/patients/p3", o.token)).data.history[0].body, /Recorded by the office for Amira Shah: Arm replaced/);
  assert.strictEqual((await call("POST", "/api/appointments/a2/record", o.token, { outcome: "done" })).status, 409, "only once");
  assert.match((await call("POST", "/api/appointments/b2/record", o.token, { outcome: "done" })).data.error, /hasn't started yet/, "June's visit is at 10:30");

  const o2 = await office();
  const m = await call("POST", "/api/appointments/a2/record", o2.token, { outcome: "missed", rebook: true, note: "No answer, curtains closed." });
  assert.strictEqual(m.data.status, "missed");
  const st = await state(o2.token);
  assert.ok(st.waitlist.some((w) => w.id === m.data.rebooked && w.patientId === "p3" && w.prio === "soon"));
  assert.strictEqual(st.metrics.cancellations, 0, "nobody in isn't a cancellation");
});

test("a gap can go to someone who asked to be phoned: the office rings them and books them in one click", async () => {
  const o = await office();
  await call("PUT", "/api/patients/p13", o.token, { contact: "Call" }); // Sylvia, waiting for a follow-up check
  const refill = (await call("POST", "/api/appointments/a3/cancel", o.token, { reason: "Patient unwell" })).data;
  assert.ok(!refill.offers.some((x) => x.name === "Sylvia Moon"), "she's never texted an offer");
  const gap = (await call("GET", "/api/gaps/a3", o.token)).data;
  const sylvia = gap.candidates.find((c) => c.name === "Sylvia Moon");
  assert.ok(sylvia.ok && sylvia.byPhone);
  assert.ok(gap.offeredTo.length, "the texted offers are still out");
  const b = await call("POST", "/api/gaps/a3/book", o.token, { waitlistId: sylvia.waitlistId });
  assert.strictEqual(b.status, 200); assert.ok(b.data.byOffice);
  const st = await state(o.token);
  assert.ok(st.appts.some((a) => a.filledFrom === "a3" && a.patientId === "p13" && a.status === "booked"));
  assert.ok(!st.messages.some((m) => m.name === "Sylvia Moon"), "she was phoned, so she isn't texted");
  for (const offer of refill.offers) assert.ok(st.messages.some((m) => m.name === offer.name && /has just been taken/.test(m.body)), `${offer.name} hears it's gone`);
  assert.strictEqual(st.offers.length, 0);
  assert.strictEqual((await call("POST", "/api/gaps/a3/book", o.token, { waitlistId: sylvia.waitlistId })).status, 409, "the gap is filled");
  assert.strictEqual((await call("GET", "/api/gaps/a1", o.token)).status, 404, "a completed visit isn't a gap");
  // A gap whose time has passed can't be booked into
  const o2 = await office();
  await call("POST", "/api/appointments/a5/cancel", o2.token, { reason: "Patient unwell" }); // Stanley, 15:00 today
  assert.strictEqual((await call("GET", "/api/gaps/a5", o2.token)).status, 200);
  require("../server/sandbox").get(o2.sandbox).t0 -= 5 * 3600e3; // the demo clock moves on to 15:20
  const late = await call("GET", "/api/gaps/a5", o2.token);
  assert.strictEqual(late.status, 409); assert.match(late.data.error, /already passed/);
});

test("the family cancellation link: initials only, cancels once, starts the refill; reminders carry it", async () => {
  const o = await office();
  const { url } = (await call("POST", "/api/appointments/a4/cancel-link", o.token)).data;
  const m = url.match(/\/cancel\/([A-Z0-9]{6})\/([\w-]{20,})$/);
  assert.ok(m, url); assert.strictEqual(m[1], o.sandbox);
  const view = (await call("GET", `/api/public/${m[1]}/visit/${m[2]}`)).data;
  assert.deepStrictEqual([view.state, view.patient, view.clinician], ["booked", "K. Ollerton", "Amira"]);
  assert.doesNotMatch(JSON.stringify(view), /Spen Lane|07700/);
  const c = await call("POST", `/api/public/${m[1]}/visit/${m[2]}/cancel`, null, { reason: "Admitted to hospital" });
  assert.strictEqual(c.status, 200);
  const st = await state(o.token);
  assert.strictEqual(st.appts.find((a) => a.id === "a4").reason, "Admitted to hospital");
  assert.ok(st.messages.some((x) => x.toClin === "c1" && /has cancelled online/.test(x.body)));
  assert.strictEqual((await call("POST", `/api/public/${m[1]}/visit/${m[2]}/cancel`, null, {})).status, 409);
  assert.strictEqual((await call("GET", `/api/public/${m[1]}/visit/not-a-real-token-at-all`)).status, 404);
  await call("POST", "/api/reminders/send", o.token);
  const reminder = (await texts(o.token)).find((x) => x.kind === "reminder");
  assert.match(reminder.body, /Reply CANCEL or cancel online at http:\/\/127\.0\.0\.1:\d+\/cancel\/[A-Z0-9]{6}\//);
});

test("the team: add a part-time clinician, who sets up their own sign-in from an invitation; hours shape bookings; leavers are signed out", async () => {
  const o = await office();
  const hours = [[540, 1020], [540, 780], null, [540, 1020], [540, 1020]];
  const add = await call("POST", "/api/team/clinicians", o.token, { name: "Nadia Khan", role: "Optometrist", email: "nadia@airevalleyeyecare.example", areaName: "Leeds city", patch: "LS6, LS7", near: "LS16", base: "LS6", hours });
  assert.strictEqual(add.status, 200, JSON.stringify(add.data));
  const cid = add.data.id;
  assert.deepStrictEqual(add.data.hours, hours);
  assert.strictEqual((await signIn("nadia@airevalleyeyecare.example", o.sandbox)).status, 401, "no password until she sets one");
  assert.match(add.data.invite.url, /\/invite\/[A-Z0-9]+\/[\w-]{40,}$/);
  const nadia = await acceptInvite(add.data.invite);
  assert.strictEqual(nadia.status, 200); assert.strictEqual(nadia.user.clinicianId, cid);
  const mine = await state(nadia.token);
  assert.strictEqual(mine.clinicians[0].name, "Nadia Khan");
  // The booking search uses her hours: nothing on her day off, nothing after 13:00 on Tuesday
  const svc = require("../server/service"), sandbox = require("../server/sandbox");
  const hers = sandbox.run(sandbox.get(o.sandbox), () => require("../server/refill").suggestSlots({ pc: "LS6 4DH", type: "repair", clinicians: [svc.getClinician(cid)], appts: [], now: 620 }));
  assert.ok(hers.some((s) => s.day === 1) && hers.some((s) => s.day === 3), "she's offered on her working days");
  assert.ok(hers.every((s) => s.day !== 2 && (s.day !== 1 || s.end <= 780)));
  const ranked = (await call("POST", "/api/slots", o.token, { patientId: "p5", type: "repair", avail: "any" })).data.slots;
  assert.ok(ranked.every((s) => s.clinicianId !== cid || (s.day !== 2 && (s.day !== 1 || s.end <= 780))));
  assert.strictEqual((await call("POST", "/api/team/clinicians", o.token, { name: "Twin", role: "Optometrist", email: "NADIA@airevalleyeyecare.example", patch: "LS6", base: "LS6", hours })).status, 409, "emails are unique");
  assert.match((await call("POST", "/api/team/clinicians", o.token, { name: "X Y", role: "Optometrist", email: "x@y.example", patch: "QQ1", base: "LS6", hours })).data.error, /QQ1/);
  // Shortening Amira's day would strand her booked visits: refused, with who's affected
  const amira = (await call("GET", "/api/team", o.token)).data.clinicians.find((c) => c.id === "c1");
  const early = await call("POST", "/api/team/clinicians", o.token, { ...amira, hours: [[540, 720], [540, 1020], [540, 1020], [540, 1020], [540, 1020]] });
  assert.strictEqual(early.status, 409); assert.match(early.data.error, /outside those hours/);
  assert.match((await call("POST", "/api/team/clinicians/c1/active", o.token, { active: false })).data.error, /visits booked/);
  // Nadia leaves: she's signed out at once and can't sign back in; her history stays
  assert.strictEqual((await call("POST", `/api/team/clinicians/${cid}/active`, o.token, { active: false })).status, 200);
  assert.strictEqual((await call("GET", "/api/state", nadia.token)).status, 401);
  assert.strictEqual((await signIn("nadia@airevalleyeyecare.example", o.sandbox)).status, 401);
  assert.ok(!(await state(o.token)).staff.some((u) => u.clinicianId === cid));
  assert.strictEqual((await call("POST", "/api/team/clinicians", nadia.token, { name: "A B" })).status, 401);
});

test("office accounts: add one, who sets up their sign-in from an invitation; nobody can switch off themselves or the last office account", async () => {
  const o = await office();
  const add = await call("POST", "/api/team/staff", o.token, { name: "Jo Bright", title: "Receptionist", email: "jo@airevalleyeyecare.example" });
  assert.strictEqual(add.status, 200);
  const jo = await acceptInvite(add.data.invite);
  assert.strictEqual(jo.user.role, "admin");
  assert.match((await call("POST", `/api/team/staff/${jo.user.id}/active`, jo.token, { active: false })).data.error, /your own account/);
  assert.strictEqual((await call("POST", "/api/team/staff/u-admin/active", jo.token, { active: false })).status, 200, "Jo switches Sarah off");
  assert.strictEqual((await call("GET", "/api/state", o.token)).status, 401, "Sarah is signed out");
  const amira = await signIn("amira@airevalleyeyecare.example", o.sandbox);
  assert.strictEqual((await call("POST", "/api/team/staff", amira.token, { name: "Hacker", email: "h@x.example" })).status, 403, "clinicians can't add accounts");
});

test("UK GDPR: export everything held about a patient; erase on request, but never someone already seen", async () => {
  const o = await office();
  const ex = await call("GET", "/api/patients/p5/export", o.token);
  assert.strictEqual(ex.status, 200);
  assert.strictEqual(ex.data.patient.name, "Margaret Holt");
  assert.ok(ex.data.notes.length && ex.data.waitingList.length);
  assert.ok((await call("GET", "/api/debug/overview", o.token)).data.audit.some((a) => a.action === "patient.export"));
  assert.match((await call("POST", "/api/patients/p4/erase", o.token, { confirm: "Ken Ollerton" })).data.error, /booked. Cancel it first/);
  assert.match((await call("POST", "/api/patients/p1/erase", o.token, { confirm: "Dorothy Fenwick" })).data.error, /must be kept/);
  assert.match((await call("POST", "/api/patients/p40/erase", o.token, { confirm: "Brenda" })).data.error, /full name to confirm/);
  await call("GET", "/api/patients/p40", o.token); // opening the record writes her name in the activity log
  assert.strictEqual((await call("POST", "/api/patients/p40/erase", o.token, { confirm: "brenda kitson" })).status, 200);
  const st = await state(o.token);
  const p = st.patients.find((x) => x.id === "p40");
  assert.ok(p.erased); assert.strictEqual(p.name, "Erased patient"); assert.strictEqual(p.phone, "");
  assert.ok(!st.recalls.some((r) => r.patientId === "p40") && !st.waitlist.some((w) => w.patientId === "p40"));
  const ov = (await call("GET", "/api/debug/overview", o.token)).data;
  assert.doesNotMatch(JSON.stringify(ov.audit), /Brenda Kitson/);
  assert.strictEqual((await call("PUT", "/api/patients/p40", o.token, { name: "Back Again" })).status, 409);
  assert.strictEqual((await call("POST", "/api/patients/p40/erase", o.token, { confirm: "Erased patient" })).status, 409);
});

test("the office adds a patient by hand; the essentials are required and nobody is entered twice", async () => {
  const o = await office();
  const before = (await state(o.token)).patients.length;
  assert.match((await call("POST", "/api/patients", o.token, { name: "Edna Pole", addr: "3 Moor Road" })).data.error, /postcode|phone/);
  const r = await call("POST", "/api/patients", o.token, { name: "Edna Pole", dob: "1938-04-02", addr: "3 Moor Road", pc: "LS16", phone: "07700 900321", eligibility: "Parkinson's", alerts: "Key safe by the door" });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.strictEqual(r.data.patient.age, 88);
  assert.deepStrictEqual(r.data.patient.alerts, ["Key safe by the door"]);
  assert.strictEqual((await state(o.token)).patients.length, before + 1);
  const twin = await call("POST", "/api/patients", o.token, { name: "edna pole", addr: "Somewhere else", pc: "LS6", phone: "07700900321" });
  assert.strictEqual(twin.status, 409);
  assert.strictEqual(twin.data.patientId, r.data.patient.id, "points to the record already there");
  assert.match((await call("POST", "/api/patients", o.token, { name: "Ann Nurse", addr: "1 Hill Top", pc: "LS16", phone: "01132 496000" })).data.error, /Texts need a mobile/);
  const audit = JSON.stringify((await call("GET", "/api/debug/table/audit", o.token)).data);
  assert.ok(audit.includes("patient.create") && !audit.includes("Edna"), "audited without personal details");
  const clin = await signIn("amira@airevalleyeyecare.example", o.sandbox);
  if (clin.token) assert.strictEqual((await call("POST", "/api/patients", clin.token, { name: "X Y", addr: "1 Road", pc: "LS16", phone: "07700 900111" })).status, 403);
});

test("a clinician marks a visit they couldn't do: reason on the record, PCSE notice withdrawn, back on the waiting list", async () => {
  const o = await office();
  const st = await state(o.token);
  const visit = st.appts.find((a) => a.day === 0 && a.type === "sight" && a.status === "booked" && a.start > st.now);
  assert.ok(visit, "an NHS sight test later today");
  assert.strictEqual(visit.pvn, "lodged", "demo visits were notified to PCSE before the demo");
  const clinId = visit.clinicianId, email = { c1: "amira", c2: "tom", c3: "priya" }[clinId] + "@airevalleyeyecare.example";
  const clin = await signIn(email, o.sandbox);
  const mine = (await state(clin.token)).appts.find((a) => a.id === visit.id);
  assert.strictEqual(mine.pvn, "lodged", "the clinician can see it too");
  // Not before the visit has started
  assert.strictEqual((await call("POST", `/api/appointments/${visit.id}/not-done`, clin.token, { reason: "nobody" })).status, 409);
  await call("POST", `/api/appointments/${visit.id}/status`, clin.token, { status: "enroute" });
  assert.strictEqual((await call("POST", `/api/appointments/${visit.id}/not-done`, clin.token, { reason: "lunch" })).status, 400);
  const r = await call("POST", `/api/appointments/${visit.id}/not-done`, clin.token, { reason: "nobody", note: "Rang twice, no answer" });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.strictEqual(r.data.status, "missed");
  assert.ok(r.data.rebooked);
  const after = await state(o.token);
  assert.ok(after.waitlist.some((w) => w.patientId === visit.patientId && w.status === "waiting"), "back on the waiting list");
  assert.ok(after.pcse.some((t) => t.appointmentId === visit.id && t.action === "cancel" && t.status === "todo"), "the office is told to withdraw PCSE's notification");
  assert.strictEqual(after.appts.find((a) => a.id === visit.id).pvn, "cancelled");
  const rec = (await call("GET", `/api/patients/${visit.patientId}`, o.token)).data;
  assert.ok(rec.history.some((h) => /Nobody in when .* called at .*Rang twice/.test(h.body)));
  // Another clinician can't mark it, and it can't be marked twice
  assert.strictEqual((await call("POST", `/api/appointments/${visit.id}/not-done`, clin.token, { reason: "nobody" })).status, 409);
});

test("recalls text themselves at the practice's recall time; phone-only patients stay for the office; consent fields saved", async () => {
  const o = await office();
  const before = await state(o.token);
  assert.strictEqual(before.settings.autoRecalls, true);
  // The demo clock starts after the recall time, so the first sweep has sent them
  const svc = require("../server/service"), sandbox = require("../server/sandbox");
  const sb = sandbox.get(o.sandbox);
  sandbox.run(sb, () => svc.sweepRecalls());
  const st = await state(o.token);
  const due = st.recalls.filter((r) => r.dueDay <= 14 && r.status !== "dismissed");
  for (const r of due) {
    const p = st.patients.find((x) => x.id === r.patientId);
    assert.strictEqual(r.status, p.contact === "Text" ? "texted" : "due", `${p.name} (${p.contact})`);
  }
  const sent = st.messages.filter((m) => m.kind === "recall");
  assert.ok(sent.length >= 1 && sent.every((m) => /\/book\//.test(m.body)), "with the booking link");
  assert.ok(sent.every((m) => !/ nhs /.test(m.body)), "NHS keeps its capitals");
  // Only once a day
  sandbox.run(sb, () => svc.sweepRecalls());
  assert.strictEqual((await state(o.token)).messages.filter((m) => m.kind === "recall").length, sent.length);
  // Power of attorney and consent to talk to family
  const r = await call("PUT", "/api/patients/p4", o.token, { poa: "Daughter Karen Hill, 07700 900777", share: "yes" });
  assert.deepStrictEqual(r.data.changed, ["power of attorney", "consent to talk to family"]);
  assert.strictEqual((await call("PUT", "/api/patients/p4", o.token, { share: "maybe" })).status, 400);
  const p = (await call("GET", "/api/patients/p4", o.token)).data;
  assert.strictEqual(p.poa, "Daughter Karen Hill, 07700 900777");
  assert.strictEqual(p.share, "yes");
});
