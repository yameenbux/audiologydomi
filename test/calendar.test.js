"use strict";
process.env.ROUTING_PROVIDER = "estimate";
// The calendar: real dates, weekends, bank holidays, the practice's own closure days, how far ahead each kind of
// booking may go, PCSE's 48 working hours, and a live practice moving on a day at midnight.
const test = require("node:test");
const assert = require("node:assert");
const cal = require("../server/calendar");
const sandbox = require("../server/sandbox");
const { start, server } = require("../server/index");

// The demo's today is Monday 12 October 2026: day 4 is Friday 16th, day 7 Monday 19th, day 74 Christmas Day.
const demo = { live: false, settings: {} };

test("day numbers are real dates, and weekends and bank holidays are closed", () => {
  assert.strictEqual(cal.label(0, demo), "Mon 12 Oct");
  assert.strictEqual(cal.longLabel(7, demo), "Monday 19 October");
  assert.strictEqual(cal.iso(74, demo), "2026-12-25");
  assert.strictEqual(cal.dayOf("2026-12-25", demo), 74);
  assert.strictEqual(cal.closedWhy(5, demo), "Saturday");
  assert.strictEqual(cal.closedWhy(74, demo), "Christmas Day");
  assert.strictEqual(cal.closedWhy(77, demo), "Boxing Day (substitute day)");
  assert.strictEqual(cal.closedWhy(4, demo), null);
  assert.deepStrictEqual(cal.openDays(4, 3, 365, demo), [4, 7, 8]);
  assert.strictEqual(cal.phrase(1, demo), "tomorrow");
  assert.strictEqual(cal.phrase(9, demo), "on Wednesday 21 Oct");
});

test("the practice's own closure days are closed too", () => {
  const sb = { live: false, settings: { closures: [{ date: "2026-10-14", reason: "Staff training" }] } };
  assert.strictEqual(cal.closedWhy(2, sb), "Staff training");
  assert.deepStrictEqual(cal.openDays(0, 4, 365, sb), [0, 1, 3, 4]);
});

test("PCSE's 48 hours are working hours: weekends and bank holidays don't count", () => {
  // From Monday 10:00 to the next Monday 10:00 is 5 working days (7,200 min), not 7 days.
  assert.strictEqual(cal.workMinutesUntil(7, 600, 600, demo), 7200);
  // A Monday 10:00 visit needs its notice lodged by the Thursday before at 10:00.
  assert.deepStrictEqual(cal.lodgeBy(7, 600, 2880, demo), { day: 3, min: 600 });
  // Over Christmas: a Tuesday 29 December visit (day 78) skips Christmas Day, the weekend and Boxing Day.
  assert.deepStrictEqual(cal.lodgeBy(78, 600, 2880, demo), { day: 72, min: 600 });
  // On Wednesday (day 2), from Monday 10:00 there are 2,280 working minutes to midnight: a sight test can start at 10:00.
  assert.strictEqual(cal.earliestWithNotice(2, 600, 2880, demo), 600);
  assert.strictEqual(cal.earliestWithNotice(5, 600, 2880, demo), Infinity);
});

test("the browser gets every day from two weeks back to the booking limit", () => {
  const v = cal.view({ live: false, settings: { bookAheadDays: 180 } });
  assert.strictEqual(v.today, "2026-10-12");
  assert.strictEqual(v.days.length, 14 + 180 + 1);
  assert.strictEqual(v.days.find((d) => d.day === 74).why, "Christmas Day");
  assert.strictEqual(v.onlineAheadDays, 42);
});

test("a live practice moves on at midnight: day numbers shift and reminders run again", () => {
  const live = require("../server/live");
  const sb = sandbox.create();
  sb.flush = () => null;
  const days = () => sandbox.run(sb, () => sb.db.prepare("SELECT id, day FROM appointments ORDER BY id").all());
  const before = days();
  sb.calDay = cal.dayNumber(cal.londonToday()) - 3; sb.remindedDay = 5;
  assert.strictEqual(live.roll(sb), 3);
  const after = days();
  assert.ok(before.length > 0);
  assert.deepStrictEqual(after.map((a) => a.day), before.map((a) => a.day - 3));
  assert.strictEqual(sb.remindedDay, 0);
  assert.strictEqual(live.roll(sb), 0, "only once a day");
});

/* ---------- Through the API ---------- */
let base;
test.before(async () => { const s = await start(0); base = `http://127.0.0.1:${s.address().port}`; });
test.after(() => server.close());
const PASSWORD = require("../server/auth").DEMO_PASSWORD;
async function call(method, path, cookie, body) {
  const res = await fetch(base + path, { method, headers: { "Content-Type": "application/json", "X-Domi": "1", ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json(), cookie: (res.headers.get("set-cookie") || "").split(";")[0] };
}
async function office() {
  const sandbox = (await call("POST", "/api/demo/start")).data.sandbox;
  const pw = await call("POST", "/api/auth/password", null, { sandbox, email: "sarah@airevalleyeyecare.example", password: PASSWORD });
  const code = (await call("GET", "/api/auth/demo-code?challenge=" + encodeURIComponent(pw.data.challenge))).data.code;
  const r = await call("POST", "/api/auth/code", null, { challenge: pw.data.challenge, code });
  return { token: r.cookie, sandbox };
}

test("the office books months ahead, never on a bank holiday, and not past the limit", async () => {
  const o = await office();
  const st = (await call("GET", "/api/state", o.token)).data;
  assert.strictEqual(st.cal.today, "2026-10-12");
  assert.strictEqual(st.cal.bookAheadDays, 365);

  const far = await call("POST", "/api/slots", o.token, { patientId: "p9", type: "repair", avail: "any", date: "2026-12-21" });
  assert.strictEqual(far.status, 200);
  assert.strictEqual(far.data.from, 70);
  assert.ok(far.data.slots.length > 0);
  assert.ok(far.data.slots.every((s) => s.day >= 70 && ![74, 75, 76, 77].includes(s.day)), "nothing over Christmas");

  const pick = far.data.slots[0];
  const ok = await call("POST", "/api/bookings", o.token, { patientId: "p9", type: "repair", avail: "any", clinicianId: pick.clinicianId, day: pick.day, start: pick.start });
  assert.strictEqual(ok.status, 200, JSON.stringify(ok.data));

  const xmas = await call("POST", "/api/bookings", o.token, { patientId: "p4", type: "repair", avail: "any", clinicianId: pick.clinicianId, day: 74, start: 600 });
  assert.strictEqual(xmas.status, 400);
  assert.match(xmas.data.error, /Christmas Day/);

  const tooFar = await call("POST", "/api/slots", o.token, { patientId: "p4", type: "repair", date: "2028-01-10" });
  assert.strictEqual(tooFar.status, 400);
  assert.match(tooFar.data.error, /12 months ahead/);

  // A gap that far off isn't texted round the waiting list: it's left open for normal booking.
  const appt = (await call("GET", "/api/state", o.token)).data.appts.find((a) => a.patientId === "p9" && a.day === pick.day);
  const cancel = await call("POST", `/api/appointments/${appt.id}/cancel`, o.token, { reason: "Patient unwell" });
  assert.strictEqual(cancel.status, 200);
  assert.strictEqual(cancel.data.outcome, "unfilled");
  assert.match(cancel.data.why, /left open for normal booking/);
});

test("closure days: refused when visits are booked, otherwise closed in the diary", async () => {
  const o = await office();
  const st = (await call("GET", "/api/state", o.token)).data;
  const busy = st.appts.find((a) => a.day > 0 && ["booked", "enroute"].includes(a.status));
  const busyIso = st.cal.days.find((d) => d.day === busy.day).iso;
  const refused = await call("PUT", "/api/settings", o.token, { closures: [{ date: busyIso, reason: "Training" }] });
  assert.strictEqual(refused.status, 409);
  assert.match(refused.data.error, /booked/);

  const saved = await call("PUT", "/api/settings", o.token, { closures: [{ date: "2026-11-20", reason: "Staff training" }] });
  assert.strictEqual(saved.status, 200, JSON.stringify(saved.data));
  const day = (await call("GET", "/api/state", o.token)).data.cal.days.find((d) => d.iso === "2026-11-20");
  assert.strictEqual(day.open, false);
  assert.strictEqual(day.why, "Staff training");
  const slots = await call("POST", "/api/slots", o.token, { patientId: "p9", type: "repair", date: "2026-11-20" });
  assert.ok(slots.data.slots.every((s) => s.day !== day.day));

  const limits = await call("PUT", "/api/settings", o.token, { bookAheadDays: 182, onlineAheadDays: 200 });
  assert.strictEqual(limits.status, 400, "online can't go further than the office");
});

test("online booking stops at its own limit, and offers later dates up to it", async () => {
  const o = await office();
  const info = (await call("GET", `/api/state`, o.token)).data;
  const type = info.settings.online[0];
  const first = await call("POST", `/api/public/${o.sandbox}/slots`, null, { pc: "LS16 5AB", type, avail: "any" });
  assert.strictEqual(first.status, 200, JSON.stringify(first.data));
  assert.ok(first.data.slots.every((s) => s.day >= 1 && s.day <= 42));
  assert.ok(first.data.next > first.data.from, "there are later dates to look at");
  const later = await call("POST", `/api/public/${o.sandbox}/slots`, null, { pc: "LS16 5AB", type, avail: "any", from: first.data.next });
  assert.strictEqual(later.status, 200);
  assert.ok(later.data.slots.every((s) => s.day >= first.data.next));
  const past = await call("POST", `/api/public/${o.sandbox}/slots`, null, { pc: "LS16 5AB", type, avail: "any", from: 60 });
  assert.strictEqual(past.status, 400);
});
