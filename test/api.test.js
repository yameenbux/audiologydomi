"use strict";
process.env.ROUTING_PROVIDER = "estimate"; // the diary tests must not depend on a third-party router
// End-to-end API tests against the real HTTP server on a random port.
const test = require("node:test");
const assert = require("node:assert");
const { start, server } = require("../server/index");

let base;
test.before(async () => { const s = await start(0); base = `http://127.0.0.1:${s.address().port}`; });
test.after(() => server.close());

const EMAIL = { "u-admin": "sarah@airevalleyeyecare.example", "u-c1": "amira@airevalleyeyecare.example", "u-c2": "tom@airevalleyeyecare.example", "u-c3": "priya@airevalleyeyecare.example" };
const PASSWORD = require("../server/auth").DEMO_PASSWORD;

async function call(method, path, cookie, body, headers = {}) {
  const res = await fetch(base + path, { method, headers: { "Content-Type": "application/json", "X-Domi": "1", ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json(), cookie: (res.headers.get("set-cookie") || "").split(";")[0] };
}
/** The code an authenticator app would show, read the way the demo's "fill it in" helper does. */
const demoCode = async (challenge) => (await call("GET", "/api/auth/demo-code?challenge=" + encodeURIComponent(challenge))).data.code;
/** Sign in properly: password, then the two-factor code. Returns the session cookie as `token`. */
async function login(userId, sandbox) {
  if (!sandbox) sandbox = (await call("POST", "/api/demo/start")).data.sandbox;
  const pw = await call("POST", "/api/auth/password", null, { sandbox, email: EMAIL[userId], password: PASSWORD });
  if (pw.status !== 200) return { status: pw.status, ...pw.data };
  const r = await call("POST", "/api/auth/code", null, { challenge: pw.data.challenge, code: await demoCode(pw.data.challenge) });
  return { token: r.cookie, sandbox: r.data.sandbox, user: r.data.user, status: r.status };
}
const state = async (t) => (await call("GET", "/api/state", t)).data;

test("a cancellation 40 minutes out offers the top three at once; first YES wins", async () => {
  const office = await login("u-admin");
  const r = (await call("POST", "/api/appointments/a3/cancel", office.token, { reason: "Patient unwell" })).data;
  assert.strictEqual(r.outcome, "offered");
  assert.strictEqual(r.plan.mode, "parallel");
  assert.deepStrictEqual(r.offers.map((o) => o.name), ["Margaret Holt", "Sylvia Moon", "Geoffrey Lumb"]);
  const gerald = r.candidates.find((c) => c.patientId === "p16");
  assert.ok(gerald && !gerald.ok && /needs 48h notice/.test(gerald.reason), "an urgent NHS sight test can't go in today: PCSE needs 48 hours");
  assert.match(r.offers[0].body, /first person to reply YES/);

  const no = (await call("POST", "/api/demo/sms", office.token, { patientId: "p41", body: "No thanks" })).data;
  assert.strictEqual(no.action, "declined");
  assert.strictEqual(no.remaining, 2, "the others are still being asked");

  const yes = (await call("POST", "/api/demo/sms", office.token, { patientId: "p5", body: "Yes please" })).data;
  assert.strictEqual(yes.action, "accepted");

  const s = await state(office.token);
  const filled = s.appts.find((a) => a.moved);
  assert.strictEqual(filled.patientId, "p5");
  assert.ok(s.messages.some((m) => m.name === "Sylvia Moon" && /just been taken/.test(m.body)), "Sylvia is told it's gone");
  assert.strictEqual(s.waitlist.find((w) => w.patientId === "p13").status, "waiting", "Sylvia keeps her place");
  assert.strictEqual(s.metrics.refilled, 1);
  assert.strictEqual(s.metrics.recovered, s.settings.fee);
  assert.strictEqual(s.metrics.fillRate, 100);

  const late = (await call("POST", "/api/demo/sms", office.token, { patientId: "p13", body: "YES" })).data;
  assert.notStrictEqual(late.action, "accepted", "a late YES can't double-book");
});

test("a patient texting CANCEL cancels their visit and starts the refill", async () => {
  const office = await login("u-admin");
  const r = (await call("POST", "/api/demo/sms", office.token, { patientId: "p4", body: "CANCEL" })).data;
  assert.strictEqual(r.action, "cancelled");
  assert.strictEqual(r.refill.cancelled.byText, true);
  assert.strictEqual(r.refill.plan.mode, "single", "13:30 is hours away, so one person at a time");
  const s = await state(office.token);
  assert.strictEqual(s.appts.find((a) => a.id === "a4").status, "cancelled");
  assert.ok(s.messages.some((m) => m.name === "Ken Ollerton" && /we've cancelled/.test(m.body)));
});

test("each demo is private; phone and laptop share one by code", async () => {
  const a = await login("u-admin");
  const b = await login("u-admin");
  assert.notStrictEqual(a.sandbox, b.sandbox);
  await call("POST", "/api/appointments/a3/cancel", a.token, { reason: "Patient unwell" });
  assert.strictEqual((await state(b.token)).appts.find((x) => x.id === "a3").status, "booked", "B is unaffected");

  const phone = await login("u-c1", a.sandbox);
  assert.strictEqual(phone.sandbox, a.sandbox);
  const ps = await state(phone.token);
  assert.ok(ps.messages.some((m) => /cancelled/.test(m.body)), "Amira's phone sees the office's change");
  assert.strictEqual((await call("POST", "/api/demo/start", null, { join: "NOPE99" })).status, 404);
});

test("clinicians can't play the patient or reach office endpoints", async () => {
  const office = await login("u-admin");
  const amira = await login("u-c1", office.sandbox);
  assert.strictEqual((await call("POST", "/api/demo/sms", amira.token, { patientId: "p5", body: "YES" })).status, 403);
  assert.strictEqual((await call("POST", "/api/admin/reset", amira.token)).status, 403);
  assert.strictEqual((await call("GET", "/api/patients/p7", amira.token)).status, 403, "Tom's patient");
});

test("the public SMS webhook is closed in demo mode and rejects unsigned requests", async () => {
  const r = await fetch(base + "/api/sms/inbound", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "From=07700900533&Body=YES" });
  assert.strictEqual(r.status, 404);
});

test("opening a record is audited; background refreshes are not", async () => {
  const office = await login("u-admin");
  await call("GET", "/api/patients/p5", office.token);
  await call("GET", "/api/patients/p5?background=1", office.token);
  await call("GET", "/api/patients/p5?background=1", office.token);
  const views = (await call("GET", "/api/debug/overview", office.token)).data.audit.filter((a) => a.action === "patient.view");
  assert.strictEqual(views.length, 1);
});

test("booking a new visit: ranked slots, booked into the round, can't be double-booked", async () => {
  const office = await login("u-admin");
  const found = (await call("POST", "/api/slots", office.token, { patientId: "p9", type: "repair", avail: "pm" })).data;
  assert.ok(found.slots.length > 0, "Irene (LS17, afternoons) gets options");
  const pick = found.slots[0];
  assert.ok(pick.start >= 720);
  assert.strictEqual(pick.route, "road", "the sample patients' full postcodes are routed by road");
  const booked = await call("POST", "/api/bookings", office.token, { patientId: "p9", type: "repair", avail: "pm", clinicianId: pick.clinicianId, day: pick.day, start: pick.start });
  assert.strictEqual(booked.status, 200);
  const s = await state(office.token);
  const v = s.appts.find((a) => a.id === booked.data.appointmentId);
  assert.strictEqual(v.start, pick.start);
  assert.strictEqual(s.waitlist.find((w) => w.patientId === "p9").status, "booked", "taken off the waiting list");
  assert.ok(s.messages.some((m) => m.name === "Irene Battye" && /is booked (today|tomorrow|on \w+day)/.test(m.body)));
  const again = await call("POST", "/api/bookings", office.token, { patientId: "p4", type: "repair", avail: "pm", clinicianId: pick.clinicianId, day: pick.day, start: pick.start });
  assert.strictEqual(again.status, 409, "the same gap can't be booked twice");
});

test("booking a brand-new patient needs a postcode we can route to", async () => {
  const office = await login("u-admin");
  const bad = await call("POST", "/api/slots", office.token, { patientId: "new", name: "Ruth Ingham", pc: "M1", type: "repair" });
  assert.strictEqual(bad.status, 400);
  const full = (await call("POST", "/api/slots", office.token, { patientId: "new", name: "Ruth Ingham", pc: "ls167sn", type: "repair" })).data;
  assert.strictEqual(full.patient.pc, "LS16 7SN", "postcodes are tidied up");
  const ok = (await call("POST", "/api/slots", office.token, { patientId: "new", name: "Ruth Ingham", pc: "LS16", addr: "3 Holt Lane", type: "repair" })).data;
  const pick = ok.slots[0];
  const b = (await call("POST", "/api/bookings", office.token, { patientId: "new", name: "Ruth Ingham", pc: "LS16", addr: "3 Holt Lane", type: "repair", clinicianId: pick.clinicianId, day: pick.day, start: pick.start })).data;
  assert.ok(b.patientId);
  assert.ok((await state(office.token)).patients.some((p) => p.name === "Ruth Ingham"));
  const amira = await login("u-c1", office.sandbox);
  assert.strictEqual((await call("POST", "/api/slots", amira.token, { patientId: "p9", type: "repair" })).status, 403, "office only");
});

test("the week: future visits exist, can be booked into, and can't be started early", async () => {
  const office = await login("u-admin");
  const s = await state(office.token);
  for (let d = 1; d <= 4; d++) assert.ok(s.appts.some((a) => a.day === d), `visits on day ${d}`);
  const slots = (await call("POST", "/api/slots", office.token, { patientId: "p13", type: "sight" })).data.slots;
  assert.ok(slots.length && slots.every((x) => x.day * 1440 + x.start >= s.now + 48 * 60), "NHS sight tests only from 48 hours ahead");
  const later = slots.find((x) => x.day >= 2);
  assert.ok(later, "offers a slot later in the week");
  const r = (await call("POST", "/api/bookings", office.token, { patientId: "p13", type: "sight", clinicianId: later.clinicianId, day: later.day, start: later.start })).data;
  const task = (await state(office.token)).pcse.find((t) => t.appointmentId === r.appointmentId);
  assert.ok(task && task.action === "lodge" && task.status === "todo", "the office is told to lodge the PCSE notification");
  assert.match(task.lodgeBy, /^(Mon|Tue|Wed) \d/);
  assert.strictEqual((await call("POST", `/api/pcse/${task.id}/done`, office.token)).status, 200);
  assert.strictEqual((await state(office.token)).pcse.find((t) => t.id === task.id).status, "done");
  const msg = (await state(office.token)).messages.find((m) => m.name === "Sylvia Moon" && /is booked/.test(m.body));
  assert.match(msg.body, /on (Wednesday|Thursday|Friday) 1\d Oct/, "the text names the day");
  const amira = await login("u-" + later.clinicianId, office.sandbox);
  const early = await call("POST", `/api/appointments/${r.appointmentId}/status`, amira.token, { status: "enroute" });
  assert.strictEqual(early.status, 409, "can't set off for a Wednesday visit on Monday");
});

test("cancelling a visit later in the week refills it one at a time, and 24h-notice patients qualify", async () => {
  const office = await login("u-admin");
  const s = await state(office.token);
  const future = s.appts.find((a) => a.day === 3 && a.clinicianId === "c3");
  const r = (await call("POST", `/api/appointments/${future.id}/cancel`, office.token, { reason: "Patient asked to rebook" })).data;
  assert.strictEqual(r.plan.mode, "single", "days away, so one person at a time");
  const ken = r.candidates.find((c) => c.patientId === "p31");
  assert.ok(ken && ken.reason !== "Needs 24h notice", "needing 24h notice doesn't rule anyone out for Thursday");
  assert.match(r.offers[0].body, /on Thursday 15 Oct/);
});

test("day-before reminders: each visit tomorrow gets one, and a CANCEL reply refills that slot", async () => {
  const office = await login("u-admin");
  const before = await state(office.token);
  const tomorrow = before.appts.filter((a) => a.day === 1 && a.status === "booked");
  const r = (await call("POST", "/api/reminders/send", office.token)).data;
  assert.strictEqual(r.sent, tomorrow.length);
  assert.strictEqual((await call("POST", "/api/reminders/send", office.token)).data.sent, 0, "never twice");
  const s = await state(office.token);
  const target = s.appts.find((a) => a.day === 1 && a.reminded);
  const p = s.patients.find((x) => x.id === target.patientId);
  const text = s.messages.find((m) => m.name === p.name && /reminder/.test(m.body));
  assert.match(text.body, /tomorrow at \d\d:\d\d/); assert.match(text.body, /Reply CANCEL/);
  const reply = (await call("POST", "/api/demo/sms", office.token, { patientId: p.id, body: "cancel" })).data;
  assert.strictEqual(reply.action, "cancelled");
  assert.strictEqual(reply.refill.slotId, target.id, "it cancels the visit they were reminded about");
  assert.strictEqual(reply.refill.plan.mode, "single", "a day ahead, so one person at a time");
  const amira = await login("u-c1", office.sandbox);
  assert.strictEqual((await call("POST", "/api/reminders/send", amira.token)).status, 403, "office only");
});

test("route map data: stops with coordinates, legs, the drive home, and a proposed visit slotted in", async () => {
  const office = await login("u-admin");
  const r = (await call("GET", "/api/route?clinician=c1&day=0", office.token)).data;
  assert.strictEqual(r.stops.length, 5);
  assert.ok(r.stops.every((s) => s.lat && s.lon && s.leg.min > 0), "every stop placed, every leg timed");
  assert.ok(r.totals.miles > 0 && r.totals.driveMin >= r.stops.reduce((t, s) => t + s.leg.min, 0));
  assert.ok(r.districts.some((d) => d.name === "LS6"));
  const p = (await call("GET", "/api/route?clinician=c1&day=0&pc=LS17%207LQ&start=755&type=repair&name=Irene", office.token)).data;
  const i = p.stops.findIndex((s) => s.proposed);
  assert.ok(i > 0 && p.stops[i - 1].start < 755 && p.stops[i + 1].start > 755, "in time order");
  const amira = await login("u-c1", office.sandbox);
  assert.strictEqual((await call("GET", "/api/route?clinician=c2", amira.token)).status, 403);
  assert.strictEqual((await call("GET", "/api/route", amira.token)).data.clinician.id, "c1", "defaults to your own round");
});

test("patients book online: only efficient slots from tomorrow, nothing about other patients, no double-booking", async () => {
  const office = await login("u-admin");
  const code = office.sandbox;
  assert.strictEqual((await call("GET", "/api/public/NOPE99")).status, 404);
  const info = (await call("GET", `/api/public/${code}`)).data;
  assert.ok(!info.types.some((t) => t.key === "dispense"), "glasses deliveries are booked by the office");
  assert.strictEqual((await call("POST", `/api/public/${code}/slots`, null, { pc: "LS16 7SN", type: "dispense" })).status, 400);
  const res = await call("POST", `/api/public/${code}/slots`, null, { pc: "LS16 7SN", type: "repair", avail: "any" });
  const slots = res.data.slots;
  assert.ok(slots.length > 0 && slots.length <= 4);
  assert.ok(slots.every((s) => s.day >= 1), "not today");
  const names = (await state(office.token)).patients.map((p) => p.name);
  assert.ok(!names.some((n) => JSON.stringify(res.data).includes(n)), "never another patient's name");
  const form = { pc: "LS16 7SN", type: "repair", avail: "any", ref: slots[0].ref, name: "Margery Hollis", phone: "07700 900777", addr: "8 Holt Park Crescent", consent: true, formMs: 20000 };
  assert.strictEqual((await call("POST", `/api/public/${code}/bookings`, null, { ...form, phone: "0113 496 0000" })).status, 400, "needs a mobile to text");
  assert.strictEqual((await call("POST", `/api/public/${code}/bookings`, null, { ...form, consent: false })).status, 400);
  const ok = await call("POST", `/api/public/${code}/bookings`, null, form);
  assert.strictEqual(ok.status, 200);
  assert.match(ok.data.when, /tomorrow|on \w+day/);
  const s = await state(office.token);
  const v = s.appts.find((a) => a.note && /booked by the patient online/.test(a.note));
  assert.ok(v && s.patients.find((p) => p.id === v.patientId).name === "Margery Hollis");
  assert.ok(s.messages.some((m) => m.name === "Margery Hollis" && /is booked/.test(m.body)), "confirmation text");
  assert.strictEqual((await call("POST", `/api/public/${code}/bookings`, null, { ...form, name: "Someone Else", phone: "07700 900778" })).status, 409, "that time has gone");
});

test("recalls join the refill pool: a cancellation can go to someone due a sight test; texting and removing recalls", async () => {
  const office = await login("u-admin");
  const s = await state(office.token);
  assert.strictEqual(s.recalls.length, 4);
  const brenda = s.recalls.find((r) => r.patientId === "p40");
  // Cancel a later-week visit in Amira's patch: recall patients are candidates, with the reason shown.
  // Thursday is more than 48 hours away, so her NHS sight test can be notified to PCSE in time.
  const visit = s.appts.find((a) => a.day === 3 && a.clinicianId === "c1" && a.type === "sight");
  const r = (await call("POST", `/api/appointments/${visit.id}/cancel`, office.token, { reason: "Patient asked to rebook" })).data;
  const cand = r.candidates.find((c) => c.patientId === "p40");
  assert.ok(cand && cand.ok && cand.why.some((w) => /Recall 12 days overdue/.test(w)), "Brenda is in the pool");
  const cancelTask = (await state(office.token)).pcse.find((t) => t.appointmentId === visit.id);
  assert.strictEqual(cancelTask.action, "cancel", "the cancelled NHS visit's notification has to be withdrawn");
  // Text a recall: link to the practice's booking page.
  const t = (await call("POST", `/api/recalls/${s.recalls.find((x) => x.patientId === "p43").id}/text`, office.token)).data;
  assert.strictEqual(t.status, "texted");
  const msg = (await state(office.token)).messages.find((m) => m.name === "Dennis Marlow");
  assert.match(msg.body, new RegExp(`/book/${office.sandbox}`));
  // Remove a recall: out of the pool too.
  await call("POST", `/api/recalls/${s.recalls.find((x) => x.patientId === "p42").id}/dismiss`, office.token);
  const after = await state(office.token);
  assert.ok(!after.waitlist.some((w) => w.patientId === "p42"));
  assert.strictEqual(after.recalls.find((x) => x.patientId === "p42").status, "dismissed");
  // Booking a recall patient closes the recall.
  const slot = (await call("POST", "/api/slots", office.token, { patientId: "p40", type: "sight" })).data.slots[0];
  await call("POST", "/api/bookings", office.token, { patientId: "p40", type: "sight", clinicianId: slot.clinicianId, day: slot.day, start: slot.start });
  assert.strictEqual((await state(office.token)).recalls.find((x) => x.id === brenda.id).status, "booked");
});

test("week report: utilisation, driving, miles and mileage value per clinician and day", async () => {
  const office = await login("u-admin");
  const r = (await call("GET", "/api/reports/week", office.token)).data;
  assert.strictEqual(r.clinicians.length, 3);
  const amira = r.clinicians.find((c) => c.clinicianId === "c1");
  assert.strictEqual(amira.days.length, 5);
  const mon = amira.days[0];
  assert.strictEqual(mon.visits, 5);
  assert.ok(mon.utilisation > 0 && mon.utilisation <= 100);
  assert.strictEqual(mon.mileagePence, Math.round(mon.miles * 45));
  assert.strictEqual(amira.total.visits, amira.days.reduce((t, d) => t + d.visits, 0));
  assert.ok(r.practice.miles > 0 && r.practice.roadShare > 0);
  const tom = await login("u-c2", office.sandbox);
  assert.strictEqual((await call("GET", "/api/reports/week", tom.token)).status, 403);
});

test("invoicing: completing a visit raises an invoice at the practice's price; pay, void, and no invoice for glasses deliveries", async () => {
  const office = await login("u-admin");
  const amira = await login("u-c1", office.sandbox);
  const done = (await call("POST", "/api/appointments/a2/status", amira.token, { status: "done" })).data; // Hilda, repair, live
  assert.strictEqual(done.invoice.number, "INV-0001");
  assert.strictEqual(done.invoice.totalPence, 1500);
  let list = (await call("GET", "/api/invoices", office.token)).data;
  assert.strictEqual(list.totals.unpaidPence, 1500);
  const one = (await call("GET", `/api/invoices/${done.invoice.id}`, office.token)).data;
  assert.strictEqual(one.patient.name, "Hilda Marsh");
  assert.strictEqual((await call("POST", `/api/invoices/${done.invoice.id}/pay`, office.token, { method: "iou" })).status, 400);
  assert.strictEqual((await call("POST", `/api/invoices/${done.invoice.id}/pay`, office.token, { method: "card" })).data.status, "paid");
  assert.strictEqual((await call("POST", `/api/invoices/${done.invoice.id}/void`, office.token)).status, 409, "paid invoices can't be voided");
  list = (await call("GET", "/api/invoices", office.token)).data;
  assert.strictEqual(list.totals.paidPence, 1500);
  assert.strictEqual((await call("GET", "/api/invoices", amira.token)).status, 403, "office only");
  // Peter's glasses delivery: price 0 by default (the glasses were charged when ordered), so no invoice.
  for (const st of ["enroute", "live", "done"]) await call("POST", "/api/appointments/a3/status", amira.token, { status: st });
  assert.strictEqual((await call("GET", "/api/invoices", office.token)).data.totals.count, 1);
  // Prices are the practice's own.
  const st = (await call("PUT", "/api/settings", office.token, { prices: { dispense: 120 } })).data;
  assert.strictEqual(st.settings.prices.dispense, 120);
  assert.deepStrictEqual(st.changed, ["prices"]);
});

test("texts are signed with the practice's name, which the office can change; the product stays Domi", async () => {
  const office = await login("u-admin");
  const st = await state(office.token);
  assert.strictEqual(st.settings.practice, "Aire Valley Eyecare");
  const first = (await call("POST", "/api/appointments/a3/cancel", office.token, { reason: "Patient unwell" })).data;
  assert.match(first.offers[0].body, /it's Aire Valley Eyecare\./);
  assert.doesNotMatch(first.offers[0].body, /Domi/);
  // The office renames the practice: new texts and the booking page use the new name
  assert.strictEqual((await call("PUT", "/api/settings", office.token, { practice: "  Kirkby   Eyecare\u0007 " })).status, 200);
  assert.strictEqual((await state(office.token)).settings.practice, "Kirkby Eyecare");
  assert.strictEqual((await call("PUT", "/api/settings", office.token, { practice: " " })).status, 400, "a blank name is refused, with a reason");
  assert.strictEqual((await state(office.token)).settings.practice, "Kirkby Eyecare");
  const pub = (await call("GET", "/api/public/" + st.sandbox)).data;
  assert.strictEqual(pub.practice, "Kirkby Eyecare");
  const ken = (await call("POST", "/api/demo/sms", office.token, { patientId: "p4", body: "CANCEL" })).data;
  const texts = JSON.stringify((await state(office.token)).messages);
  assert.match(texts, /Kirkby Eyecare/);
  assert.ok(ken);
});

test("settings feed the rest of Domi: contact details, opening hours, online booking and message previews", async () => {
  const office = await login("u-admin");
  const put = (b) => call("PUT", "/api/settings", office.token, b);
  // Contact details: checked, then used on public pages and in the top bar
  assert.match((await put({ phone: "12345" })).data.error, /UK phone/);
  assert.match((await put({ logo: "http://example.com/logo.png" })).data.error, /https/);
  const r = await put({ phone: "0113 496 0000", email: "Hello@Kirkby.example", logo: "https://kirkby.example/logo.png" });
  assert.deepStrictEqual(r.data.changed, ["phone number", "email", "logo"]);
  const st = await state(office.token);
  assert.strictEqual(st.brand.logo, "https://kirkby.example/logo.png");
  const pub = (await call("GET", "/api/public/" + st.sandbox)).data;
  assert.strictEqual(pub.brand.phone, "01134 960000");
  assert.strictEqual(pub.brand.email, "hello@kirkby.example");
  // Opening hours can't cut into a clinician's working hours
  const clash = await put({ dayEnd: 17 * 60 });
  assert.strictEqual(clash.status, 409);
  assert.match(clash.data.error, /works 09:00–17:30 on Monday.*Team page/);
  assert.strictEqual((await put({ dayStart: 8 * 60 })).status, 200, "opening earlier is fine");
  assert.strictEqual((await state(office.token)).settings.dayStart, 480);
  // Online booking offers only what the practice allows
  assert.match((await put({ online: [] })).data.error, /at least one/);
  await put({ online: ["sight"] });
  assert.deepStrictEqual((await call("GET", "/api/public/" + st.sandbox)).data.types.map((t) => t.key), ["sight"]);
  assert.strictEqual((await call("POST", `/api/public/${st.sandbox}/slots`, null, { type: "repair", pc: "LS6" })).status, 400);
  // The office sees exactly what patients will get
  await put({ practice: "Kirkby Eyecare", reminders: false });
  const m = (await call("GET", "/api/settings/messages", office.token)).data;
  assert.match(m.messages.find((x) => x.key === "reminder").body, /a reminder from Kirkby Eyecare/);
  assert.match(m.messages.find((x) => x.key === "reminder").when, /Off/);
  assert.match(m.lead.body, /0113|01134/);
  const audit = JSON.stringify((await call("GET", "/api/debug/table/audit", office.token)).data);
  assert.ok(audit.includes("Changed phone number, email, logo") && !audit.includes("kirkby.example/logo"), "the log names what changed, not the values");
});
