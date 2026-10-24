"use strict";
// HTTP API + static frontend. Zero dependencies: node:http, node:sqlite, node:crypto.
// Every request runs inside the caller's sandbox (see sandbox.js), so visitors never share data.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const sandbox = require("./sandbox");
const { db, map, TABLES, USERS, emailFor } = require("./db");
const invites = require("./invites");
const calls = require("./calls");
const pvn = require("./pvn");
const pilot = require("./pilot");
const brands = require("./brands");
const regions = require("./regions");
const D = require("./domain");
const travel = require("./travel");
const svc = require("./service");
const leads = require("./leads");
const auth = require("./auth");
const bus = require("./bus");
const { provider, verifyTwilio } = require("./notify");

const PORT = Number(process.env.PORT || 3000);
const PUBLIC = path.join(__dirname, "..", "public");

/* ---------- Sessions: server-side, referenced by an HttpOnly cookie (see auth.js) ---------- */
const pub = (u) => ({ id: u.id, name: u.name, role: u.role, clinicianId: u.clinicianId, dual: !!u.dual });
/** A clinician with office access (a director) signs in to the office, and can switch to their own round. */
const SELF = "self:clinician";
const asSignedIn = (u) => (u && u.role === "clinician" && u.office ? { ...u, role: "admin", dual: true } : u);
/** An account in a practice's own database (the office can add and switch off accounts), or null. */
const account = (sb, id) => { const r = sandbox.run(sb, () => db.prepare("SELECT * FROM users WHERE id = ?").get(String(id || ""))); return r ? map.user(r) : null; };
/** Who is calling: their session, their demo, the person signed in, and who they're viewing as. */
function verify(req) {
  const s = auth.getSession(auth.readCookie(req));
  if (!s) return null;
  const sb = sandbox.get(s.sbId);
  const real = sb && asSignedIn(account(sb, s.uid));
  const eff = sb && (s.actingAs === SELF ? account(sb, s.uid) : s.actingAs ? account(sb, s.actingAs) : real);
  if (!sb || !real || !real.active) { auth.endSession(s.id, sb ? "account switched off" : "demo expired"); return null; }
  if (!eff || !eff.active) { s.actingAs = null; auth.sessionChanged(s); return verify(req); }
  sb.lastSeen = Date.now();
  return { sb, session: s, real: pub(real), user: pub(eff) };
}
/** End every session an account has in this practice: they've just been switched off. */
const signOutEverywhere = (sb, uid, why) => auth.sessionsFor(sb.id).filter((s) => s.uid === uid || s.actingAs === uid).forEach((s) => (s.uid === uid ? auth.endSession(s.id, why) : ((s.actingAs = null), auth.sessionChanged(s))));
// Short public handle for a session, so the office can see and end sessions without ever seeing a token.
const handle = (s) => crypto.createHash("sha256").update(s.id).digest("base64url").slice(0, 12);

// Per-IP limit on failed sign-in attempts, on top of the per-account lockout. Successes don't count,
// so a busy office behind one connection is never blocked.
const attempts = new Map();
// On Fly, Fly-Client-IP is set by Fly's own proxy, so it can't be forged. Elsewhere (the Render demo) the first
// X-Forwarded-For entry is used: it can be forged, but never lumps every visitor behind one proxy address into a
// single bucket (which would let one attacker block everyone). The per-account lockout is the real protection.
const ipOf = (req) => String(req.headers["fly-client-ip"] || req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
const recentFailures = (req) => (attempts.get(ipOf(req)) || []).filter((t) => Date.now() - t < 10 * 60e3);
function limitSignIn(req) {
  if (recentFailures(req).length >= 30) throw new svc.HttpError(429, "Too many failed sign-in attempts from this connection. Wait a few minutes.");
}
const noteFailure = (req) => attempts.set(ipOf(req), [...recentFailures(req), Date.now()]);
setInterval(() => attempts.clear(), 30 * 60e3).unref();

/* ---------- Request log per sandbox, for the "Under the hood" page ---------- */
const reqLogs = new Map();
function logRequest(sb, entry) {
  const list = reqLogs.get(sb.id) || [];
  list.unshift(entry);
  list.length = Math.min(list.length, 80);
  reqLogs.set(sb.id, list);
  sandbox.run(sb, () => bus.emit({ type: "http", ...entry }));
}

/* ---------- Routing ---------- */
const routes = [];
const route = (method, pattern, opts, handler) => {
  const keys = [];
  const re = new RegExp("^" + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), "([^/]+)")) + "$");
  routes.push({ method, pattern, re, keys, handler, ...opts });
};

const send = (res, status, data, cookies = []) => {
  const text = data && typeof data.__text === "string"; // Meta's webhook check wants the challenge back as plain text
  let body = Buffer.from(text ? data.__text : JSON.stringify(data));
  const headers = { "Content-Type": text ? "text/plain; charset=utf-8" : "application/json", "Cache-Control": "no-store", Vary: "Accept-Encoding", ...(cookies.length ? { "Set-Cookie": cookies } : {}) };
  // The office's state is tens of kilobytes; gzip makes it a fraction of that on a phone connection.
  if (body.length > 2048 && /\bgzip\b/.test((res.req && res.req.headers["accept-encoding"]) || "")) { body = require("node:zlib").gzipSync(body); headers["Content-Encoding"] = "gzip"; }
  res.writeHead(status, headers);
  res.end(body);
};
async function readBody(req, max = 1e5) {
  // Collect bytes, then decode once, so a name like Siân split across two chunks isn't mangled.
  const parts = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > max) throw new svc.HttpError(413, "Request too large."); parts.push(chunk); }
  const raw = Buffer.concat(parts).toString("utf8");
  req.rawBody = raw; // Meta signs the exact bytes it sent
  if (!raw) return {};
  if ((req.headers["content-type"] || "").includes("application/x-www-form-urlencoded")) return Object.fromEntries(new URLSearchParams(raw));
  try { return JSON.parse(raw); } catch { throw new svc.HttpError(400, "Body must be JSON."); }
}
const needAdmin = (u) => { if (u.role !== "admin") throw new svc.HttpError(403, "Office staff only."); };

/* Which patients may a clinician open? Their own visits today plus their patch. */
function clinicianCanSee(user, patientId) {
  if (user.role === "admin") return true;
  const c = svc.getClinician(user.clinicianId);
  const p = svc.getPatient(patientId);
  if (!p) return false;
  const hasVisit = db.prepare("SELECT 1 FROM appointments WHERE clinician_id = ? AND patient_id = ?").get(c.id, patientId);
  return !!hasVisit || c.patch.includes(D.district(p.pc));
}

// `?brand=` styles the sign-in screen before a demo exists; afterwards the demo's own brand comes with /api/state.
// For the uptime monitor: 200 while the app and its database answer, 503 when the database doesn't. No details.
route("GET", "/api/health", { public: true }, async () => {
  let db;
  try { db = await require("./live").health(); } catch (e) { throw new svc.HttpError(503, "The database isn't answering."); }
  return { ok: true, db: db ? "ok" : "none", ms: db ? db.ms : undefined };
});
route("GET", "/api/meta", { public: true }, (req) => { const brand = brands.get(new URL(req.url, "http://x").searchParams.get("brand")); return {
  types: D.TYPES, sources: D.SOURCES, counts: D.COUNTS, prio: D.PRIO, avail: D.AVAIL, tw: D.TW, reasons: D.REASONS, dayStart: D.DAY_START, dayEnd: D.DAY_END, weekdays: D.WORK_WEEKDAYS, smsProvider: provider, routing: travel.routingStatus().provider,
  demoUsers: auth.DEMO ? USERS.map((u) => ({ id: u.id, name: u.name, role: u.role, title: u.title, color: u.color, email: emailFor(u, brand) })) : [],
  demo: auth.DEMO ? { password: auth.DEMO_PASSWORD } : null,
  // With the demo off (DEMO_MODE=0), this server runs real practices: the sign-in page signs in to this one.
  live: auth.DEMO ? null : { practice: livePractice() },
  brand: brands.pub(brand), areas: regions.areasFor(brand.region),
}; });

/* ---------- Sign-in ---------- */
// Start a private demo (a practice of its own), or check a code to join one. No account is signed in yet.
/** The practice this server signs people in to when the demo is off: PRACTICE_CODE, or the only one there is. */
function livePractice() {
  const open = sandbox.all().filter((sb) => sb.live);
  const want = String(process.env.PRACTICE_CODE || "").toUpperCase();
  const sb = want ? open.find((x) => x.id === want) : open.length === 1 ? open[0] : null;
  return sb ? { code: sb.id, name: sb.settings.practice } : null;
}

route("POST", "/api/demo/start", { public: true }, (req, body) => {
  if (!auth.DEMO) throw new svc.HttpError(404, "No such endpoint."); // a live server never makes sample practices
  if (body.join) {
    const sb = sandbox.get(String(body.join));
    if (!sb) throw new svc.HttpError(404, "That demo code has expired. Start a new demo instead.");
    return { sandbox: sb.id };
  }
  return { sandbox: sandbox.create(body.brand).id };
});

// Step 1: email and password. Returns a short-lived challenge for step 2; nothing is signed in yet.
route("POST", "/api/auth/password", { public: true }, async (req, body) => {
  limitSignIn(req);
  const sb = sandbox.get(String(body.sandbox || ""));
  if (!sb) throw new svc.HttpError(404, auth.DEMO ? "That demo has expired. Start a new one." : "Check the practice code.");
  if (!auth.DEMO && !sb.live) throw new svc.HttpError(404, "Check the practice code.");
  return sandbox.run(sb, async () => {
    const email = String(body.email || "").trim().toLowerCase();
    const found = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
    const row = found && found.active ? found : null; // a switched-off account behaves like an unknown one
    const now = Date.now();
    if (row && row.locked_until > now) throw new svc.HttpError(429, `Too many wrong attempts. This account is locked for ${Math.ceil((row.locked_until - now) / 60e3)} more min.`);
    // Unknown emails are checked against a real hash too, so timing doesn't reveal which accounts exist.
    const ok = (await auth.checkPassword(String(body.password || ""), row ? row.pass_hash : auth.DEMO_HASH)) && !!row;
    if (!ok) {
      if (row) {
        const failed = row.failed + 1, lock = failed >= auth.LOCK_AFTER;
        db.prepare("UPDATE users SET failed = ?, locked_until = ? WHERE id = ?").run(lock ? 0 : failed, lock ? now + auth.LOCK_MS : 0, row.id);
        svc.audit(row.name, lock ? "auth.locked" : "auth.failed", row.id, lock ? `Locked for ${auth.LOCK_MS / 60e3} min after ${auth.LOCK_AFTER} wrong passwords` : `Wrong password (${failed} of ${auth.LOCK_AFTER})`);
      }
      throw new svc.HttpError(401, "That email and password don't match.");
    }
    // The failure count isn't cleared here, only once the code is right too: wrong codes count against the
    // account, so a known password can't be used to guess codes over and over.
    return {
      challenge: auth.newChallenge(sb.id, row.id), name: row.name,
      // Demo only: lets a real authenticator app be set up by scanning a QR code. In production this is
      // shown once, at enrolment, after the person has proved who they are.
      demo: auth.DEMO ? { enrol: auth.otpauthUri(row.totp_secret, row.email) } : undefined,
    };
  });
});

// Step 2: the six-digit code. On success the session cookie is set.
route("POST", "/api/auth/code", { public: true }, (req, body) => {
  limitSignIn(req);
  const c = auth.getChallenge(body.challenge);
  const sb = c && sandbox.get(c.sbId);
  if (!c || !sb) throw new svc.HttpError(401, "That sign-in timed out. Enter your password again.");
  return sandbox.run(sb, () => {
    const row = db.prepare("SELECT * FROM users WHERE id = ?").get(c.uid);
    const now = Date.now();
    if (row.locked_until > now) { c.expires = 0; throw new svc.HttpError(429, `Too many wrong attempts. This account is locked for ${Math.ceil((row.locked_until - now) / 60e3)} more min.`); }
    const step = auth.matchTotp(row.totp_secret, body.code, row.totp_step);
    if (step == null) {
      // Counted against the account as well as this sign-in, with wrong passwords: the same lockout covers both.
      const failed = row.failed + 1, lock = failed >= auth.LOCK_AFTER;
      db.prepare("UPDATE users SET failed = ?, locked_until = ? WHERE id = ?").run(lock ? 0 : failed, lock ? now + auth.LOCK_MS : 0, row.id);
      c.tries++;
      svc.audit(row.name, lock ? "auth.locked" : "auth.failed", row.id, lock ? `Locked for ${auth.LOCK_MS / 60e3} min after ${auth.LOCK_AFTER} wrong attempts` : `Wrong two-factor code (${c.tries} of ${auth.CHALLENGE_TRIES})`);
      if (lock || c.tries >= auth.CHALLENGE_TRIES) c.expires = 0; // start again from the password
      if (lock) throw new svc.HttpError(429, `Too many wrong attempts. This account is locked for ${auth.LOCK_MS / 60e3} min.`);
      throw new svc.HttpError(401, c.tries >= auth.CHALLENGE_TRIES ? "Too many wrong codes. Enter your password again." : "That code isn't right, or it's already been used. Codes change every 30 seconds.");
    }
    db.prepare("UPDATE users SET totp_step = ?, failed = 0 WHERE id = ?").run(step, row.id);
    c.expires = 0; // used
    const s = auth.createSession({ sbId: sb.id, uid: row.id, kind: "password", ua: req.headers["user-agent"] });
    req.cookies.push(auth.sessionCookie(req, s.token));
    svc.audit(row.name, "auth.login", row.id, "Signed in with password and two-factor code");
    return { sandbox: sb.id, user: pub(map.user(row)) };
  });
});

// Demo only: the code the person's authenticator app would show right now.
route("GET", "/api/auth/demo-code", { public: true }, (req) => {
  if (!auth.DEMO) throw new svc.HttpError(404, "No such endpoint.");
  const c = auth.getChallenge(new URL(req.url, "http://x").searchParams.get("challenge"));
  const sb = c && sandbox.get(c.sbId);
  if (!c || !sb) throw new svc.HttpError(401, "That sign-in timed out. Enter your password again.");
  return sandbox.run(sb, () => {
    const row = db.prepare("SELECT totp_secret, totp_step FROM users WHERE id = ?").get(c.uid);
    return auth.currentCode(row.totp_secret, row.totp_step) || { code: null, secondsLeft: 30 };
  });
});

// Is this browser signed in? Answers either way, so loading the page doesn't log an error.
route("GET", "/api/auth/session", { public: true }, (req) => ({ signedIn: !!req.auth, user: req.auth ? req.auth.user : null }));

route("POST", "/api/auth/logout", {}, (req, body, user) => {
  svc.audit(req.auth.real.name, "auth.logout", req.auth.real.id, "Signed out");
  auth.endSession(req.auth.session.id);
  req.cookies.push(auth.clearCookie(req));
  return { ok: true };
});

// The office can look at the app as any clinician sees it, without their password. Audited.
route("POST", "/api/auth/view-as", {}, (req, body) => {
  if (req.auth.real.role !== "admin") throw new svc.HttpError(403, "Only the office can switch views.");
  const target = account(req.auth.sb, body.userId);
  if (!target || !target.active) throw new svc.HttpError(400, "Unknown user.");
  req.auth.session.actingAs = target.id !== req.auth.real.id ? target.id : body.as === "clinician" && req.auth.real.dual ? SELF : null;
  auth.sessionChanged(req.auth.session);
  if (target.id !== req.auth.real.id) svc.audit(req.auth.real.name, "auth.view-as", target.id, `Viewing the app as ${target.name}`);
  return { user: pub(target.id === req.auth.real.id && !req.auth.session.actingAs ? req.auth.real : target) };
});

// Demo only: a single-use link (shown as a QR code) that signs a phone in as a clinician, valid 10 minutes.
route("POST", "/api/auth/pair", {}, (req, body) => {
  if (!auth.DEMO) throw new svc.HttpError(404, "No such endpoint.");
  if (req.auth.real.role !== "admin") throw new svc.HttpError(403, "Office staff only.");
  const target = account(req.auth.sb, body.userId);
  if (!target || target.role !== "clinician" || !target.active) throw new svc.HttpError(400, "Choose a clinician.");
  const t = auth.newPairing(req.auth.sb.id, target.id, req.auth.real.id);
  svc.audit(req.auth.real.name, "auth.pair", target.id, `Created a one-time phone sign-in link for ${target.name}`);
  return { token: t, expiresIn: 600 };
});
route("POST", "/api/auth/pair/redeem", { public: true }, (req, body) => {
  limitSignIn(req);
  const p = auth.takePairing(body.token);
  const sb = p && sandbox.get(p.sbId);
  if (!p || !sb) throw new svc.HttpError(401, "That link has been used or has expired. Show a new QR code on the office screen.");
  const s = auth.createSession({ sbId: sb.id, uid: p.uid, kind: "paired", ua: req.headers["user-agent"] });
  req.cookies.push(auth.sessionCookie(req, s.token));
  const u = account(sb, p.uid);
  if (!u || !u.active) throw new svc.HttpError(401, "That account has been switched off.");
  sandbox.run(sb, () => svc.audit(u.name, "auth.login", u.id, "Signed in on a phone with a one-time link from the office"));
  return { sandbox: sb.id, user: pub(u) };
});

// Signed-in devices in this practice, and remote sign-out (a lost phone).
const sessionList = (who) => auth.sessionsFor(who.sb.id).map((s) => ({
  id: handle(s), name: (account(who.sb, s.uid) || { name: "Former account" }).name, kind: s.kind, created: s.created, lastSeen: s.lastSeen,
  device: /iPhone|Android|Mobile/.test(s.ua) ? "Phone" : "Computer", current: s.id === who.session.id,
}));
route("GET", "/api/auth/sessions", {}, (req) => {
  if (req.auth.real.role !== "admin") throw new svc.HttpError(403, "Office staff only.");
  return sessionList(req.auth);
});
route("POST", "/api/auth/sessions/:id/revoke", {}, (req, body, user, { id }) => {
  if (req.auth.real.role !== "admin") throw new svc.HttpError(403, "Office staff only.");
  const s = auth.sessionsFor(req.auth.sb.id).find((x) => handle(x) === id);
  if (!s) throw new svc.HttpError(404, "That session has already ended.");
  auth.endSession(s.id, "signed out by the office");
  const u = account(req.auth.sb, s.uid) || { id: s.uid, name: "a former account" };
  svc.audit(req.auth.real.name, "auth.revoke", u.id, `Signed ${u.name} out remotely`);
  return { ok: true };
});

route("GET", "/api/state", {}, (req, body, user) => {
  const clinicians = db.prepare("SELECT * FROM clinicians ORDER BY rowid").all().map(map.clinician);
  const isAdmin = user.role === "admin";
  const appts = (isAdmin ? db.prepare("SELECT * FROM appointments ORDER BY start_min").all() : db.prepare("SELECT * FROM appointments WHERE clinician_id = ? ORDER BY start_min").all(user.clinicianId)).map(map.appt);
  // Confirmation calls on each visit, for the diary's CC markers: the latest outcome per call (a call that was made
  // isn't undone by a later no-answer), who made it and when, and which call is due now. Clinicians only see "confirmed".
  const conf = new Map();
  for (const r of db.prepare("SELECT appointment_id, stage, outcome, by_name, at FROM confirmations ORDER BY id").all()) {
    const m = conf.get(r.appointment_id) || {}, prev = m[r.stage];
    if (!prev || prev.o === "no-answer") m[r.stage] = { o: r.outcome, by: r.by_name, at: r.at, tries: (prev ? prev.tries : 0) + (r.outcome === "no-answer" ? 1 : 0) };
    conf.set(r.appointment_id, m);
  }
  for (const a of appts) {
    const m = conf.get(a.id) || {}, made = (s) => !!m[s] && m[s].o !== "no-answer";
    if (isAdmin) { a.cc = m; a.ccDue = calls.stageDue(a, { 1: made(1), 2: made(2), 3: made(3) }); }
    else a.confirmed = made(3);
  }
  const me = !isAdmin && clinicians.find((c) => c.id === user.clinicianId);
  const patients = db.prepare("SELECT * FROM patients ORDER BY name").all().map(map.patient)
    .filter((p) => isAdmin || appts.some((a) => a.patientId === p.id) || me.patch.includes(D.district(p.pc)));
  const messages = (isAdmin ? db.prepare("SELECT * FROM messages ORDER BY id DESC LIMIT 100").all()
    : db.prepare("SELECT * FROM messages WHERE to_clinician_id = ? OR from_clinician_id = ? ORDER BY id DESC").all(user.clinicianId, user.clinicianId)).map(map.msg);
  const waitlist = isAdmin ? db.prepare("SELECT * FROM waitlist ORDER BY added_seq").all().map(map.wait) : [];
  const recalls = isAdmin ? db.prepare("SELECT * FROM recalls ORDER BY due_day").all().map(map.recall) : [];
  const offers = isAdmin ? db.prepare("SELECT * FROM offers WHERE status = 'pending'").all().map((o) => ({ ...o })) : [];
  const pcse = isAdmin ? svc.pcseList() : [];
  const pvnOf = svc.pvnStatus(); // each NHS visit's PCSE notification, so the clinician can see it before testing
  for (const a of appts) if (D.TYPES[a.type] && D.TYPES[a.type].pvn) a.pvn = pvnOf[a.id] || null;
  const referrals = isAdmin ? db.prepare("SELECT * FROM referrals ORDER BY status = 'new' DESC, id DESC").all().map(map.referral) : [];
  const leadsState = isAdmin ? { leads: leads.leadList(), leadEmails: leads.leadEmails(), leadStatus: leads.STATUS, leadPreview: leads.preview() } : { leads: [] };
  // Everyone who signs in, for the office's clinician switcher and phone sign-in. No emails or secrets.
  const staff = req.auth.real.role === "admin" ? db.prepare("SELECT * FROM users WHERE active = 1 ORDER BY role DESC, name").all().map(map.user).map((u) => ({ id: u.id, name: u.name, role: u.role, clinicianId: u.clinicianId, title: u.title, color: u.color })) : [];
  const sb = sandbox.current();
  return {
    user, signedInAs: req.auth.real, sandbox: sb.id, now: sandbox.nowMin(), clinicians: isAdmin ? clinicians : [me], appts, patients, messages, waitlist, recalls, offers, pcse, referrals, referralOptions: isAdmin ? svc.referralOptions() : null, ...leadsState, staff,
    cal: require("./calendar").view(sb), // dates, weekends, bank holidays and booking limits for the diary
    types: Object.fromEntries(Object.entries(D.TYPES).map(([k, t]) => [k, { ...t }])), // this practice's own visit lengths, read now
    pvn: isAdmin ? pvn.list().counts : null,
    diaryTodo: isAdmin ? db.prepare("SELECT COUNT(*) AS n FROM diary_log WHERE copied_at IS NULL").get().n : 0, // changes still to copy into Opticabase // PCSE notifications by status, for the side menu and Needs you today
    calls: isAdmin ? (({ calls: c }) => ({ 1: c[1].length, 2: c[2].length, 3: c[3].length }))(calls.list()) : null, // confirmation calls due today, by stage
    metrics: isAdmin ? svc.metrics() : null, textUsage: isAdmin ? require("./notify").textUsage() : null, settings: sandbox.publicSettings(sb.settings), brand: sandbox.brandView(sb), areas: regions.areasFor(sb.brand.region),
  };
});

// `background=1` is the app refreshing after a live update: not a person opening the record, so not audited.
route("GET", "/api/patients/:id", {}, (req, body, user, { id }) => {
  if (!clinicianCanSee(user, id)) throw new svc.HttpError(403, "This patient isn't on your round or in your area.");
  const p = svc.getPatient(id);
  if (!p) throw new svc.HttpError(404, "Patient not found.");
  p.nhsFrom = svc.nhsFrom(p); // the earliest NHS sight test can be claimed
  if (new URL(req.url, "http://x").searchParams.get("background") !== "1") svc.audit(user.name, "patient.view", id, p.name);
  return { ...p, history: db.prepare("SELECT * FROM notes WHERE patient_id = ? ORDER BY id DESC").all(id).map(map.note) };
});

route("POST", "/api/patients/:id/notes", {}, (req, body, user, { id }) => {
  if (!clinicianCanSee(user, id)) throw new svc.HttpError(403, "This patient isn't on your round or in your area.");
  return svc.tx(() => svc.addNote(id, body.body, user));
});

route("POST", "/api/appointments/:id/status", {}, (req, body, user, { id }) => svc.setStatus(id, body.status, user));
route("POST", "/api/appointments/:id/not-done", {}, (req, body, user, { id }) => svc.notDone(id, body, user));

route("POST", "/api/appointments/:id/seen", {}, (req, body, user, { id }) => {
  db.prepare("UPDATE appointments SET seen = 1 WHERE id = ? AND (clinician_id = ? OR ? = 'admin')").run(id, user.clinicianId, user.role);
  return { ok: true };
});

route("POST", "/api/appointments/:id/cancel", {}, (req, body, user, { id }) => {
  const a = svc.getAppt(id);
  if (!a) throw new svc.HttpError(404, "That visit no longer exists.");
  if (user.role === "clinician" && a.clinicianId !== user.clinicianId) throw new svc.HttpError(403, "This visit is on another clinician's round.");
  const reason = D.REASONS.includes(body.reason) ? body.reason : "Patient unwell";
  return svc.cancelAppointment(id, reason, user.name);
});

route("POST", "/api/waitlist", {}, (req, body, user) => { needAdmin(user); return svc.addToWaitlist(body, user); });

/* ---------- The office runs everything: patient records, visits, the team ---------- */
route("POST", "/api/patients", {}, (req, body, user) => { needAdmin(user); return svc.createPatient(body, user); });
route("PUT", "/api/patients/:id", {}, (req, body, user, { id }) => { needAdmin(user); return svc.updatePatient(id, body, user); });
// UK GDPR: a copy of everything held about a patient (subject access), and erasure on request.
route("GET", "/api/patients/:id/export", {}, (req, body, user, { id }) => { needAdmin(user); return svc.exportPatient(id, user); });
route("POST", "/api/patients/:id/erase", {}, (req, body, user, { id }) => { needAdmin(user); return svc.erasePatient(id, body, user); });
route("POST", "/api/appointments/:id/move-options", {}, (req, body, user, { id }) => { needAdmin(user); return svc.moveOptions(id, body); });
route("POST", "/api/appointments/:id/move", {}, (req, body, user, { id }) => { needAdmin(user); return svc.moveAppointment(id, body, user); });
route("PUT", "/api/appointments/:id/availability", {}, (req, body, user, { id }) => { needAdmin(user); return svc.setAvailability(id, body, user); });
route("POST", "/api/appointments/:id/record", {}, (req, body, user, { id }) => { needAdmin(user); return svc.recordOutcome(id, body, user); });
route("POST", "/api/appointments/:id/cancel-link", {}, (req, body, user, { id }) => { needAdmin(user); return svc.officeCancelLink(id, user); });
// A freed slot: who could take it, and booking the person the office has just rung.
route("GET", "/api/gaps/:id", {}, (req, body, user, { id }) => { needAdmin(user); return svc.gapCandidates(id); });
route("POST", "/api/gaps/:id/book", {}, (req, body, user, { id }) => { needAdmin(user); return svc.bookCandidate(id, body.waitlistId, user); });
route("POST", "/api/gaps/:id/skip", {}, (req, body, user, { id }) => { needAdmin(user); return svc.skipCandidate(id, body.waitlistId, body.outcome, user); });
// Each person's sign-in: set up, or waiting on an invitation or reset link (server/invites.js).
route("GET", "/api/team", {}, (req, body, user) => {
  needAdmin(user);
  const t = svc.teamList();
  t.clinicians.forEach((c) => { c.signin = c.userId ? invites.stateOf(c.userId) : null; });
  t.staff.forEach((u) => { u.signin = invites.stateOf(u.id); });
  return t;
});
// A new person gets an invitation straight away: they choose their own password and authenticator app.
route("POST", "/api/team/clinicians", {}, (req, body, user) => {
  needAdmin(user);
  const c = svc.saveClinician(body, user);
  if (!body.id) { const u = db.prepare("SELECT id FROM users WHERE clinician_id = ?").get(c.id); c.invite = invites.issue(u.id, req.auth.real, publicBase(req), { isNew: true }); }
  return c;
});
route("POST", "/api/team/users/:id/invite", {}, (req, body, user, { id }) => {
  if (req.auth.real.role !== "admin") throw new svc.HttpError(403, "Office staff only.");
  if (id === req.auth.real.id) throw new svc.HttpError(409, "You can't reset your own sign-in here. Ask another office account to do it.");
  return invites.issue(id, req.auth.real, publicBase(req));
});
route("POST", "/api/team/clinicians/:id/active", {}, (req, body, user, { id }) => {
  needAdmin(user);
  const r = svc.setClinicianActive(id, body.active === true, user);
  if (!body.active && r.userId) signOutEverywhere(req.auth.sb, r.userId, "account switched off");
  return r;
});
route("POST", "/api/team/staff", {}, (req, body, user) => {
  needAdmin(user);
  const u = svc.saveStaff(body, user);
  if (!body.id) u.invite = invites.issue(u.id, req.auth.real, publicBase(req), { isNew: true });
  return u;
});
route("POST", "/api/team/staff/:id/active", {}, (req, body, user, { id }) => {
  if (req.auth.real.role !== "admin") throw new svc.HttpError(403, "Office staff only.");
  const r = svc.setStaffActive(id, body.active === true, req.auth.real);
  if (!body.active) signOutEverywhere(req.auth.sb, r.userId, "account switched off");
  return r;
});

// Booking: ranked slots across every round for one patient, then book the chosen one.
route("POST", "/api/slots", {}, (req, body, user) => { needAdmin(user); return svc.findSlots(body); });
route("POST", "/api/bookings", {}, (req, body, user) => { needAdmin(user); return svc.bookVisit(body, user); });

route("PUT", "/api/settings", {}, (req, body, user) => { needAdmin(user); return svc.saveSettings(body, user); });
route("GET", "/api/settings/messages", {}, (req, body, user) => { needAdmin(user); return { messages: svc.messagePreviews(), lead: leads.preview() }; });

/* ---------- Patients booking online (public: no sign-in, limited per connection) ---------- */
const publicHits = new Map();
function limitPublic(req, kind, max) {
  const key = kind + ":" + ipOf(req), now = Date.now(), list = (publicHits.get(key) || []).filter((t) => now - t < 10 * 60e3);
  if (list.length >= max) throw new svc.HttpError(429, "Too many requests. Please wait a few minutes, or call us to book.");
  list.push(now); publicHits.set(key, list);
}
setInterval(() => publicHits.clear(), 30 * 60e3).unref();
const practice = (code) => { const sb = sandbox.get(code); if (!sb) throw new svc.HttpError(404, "This booking link has expired. Please call the practice."); return sb; };
route("GET", "/api/public/:code", { public: true }, (req, body, user, { code }) => {
  const sb = practice(code);
  return sandbox.run(sb, () => ({ practice: sb.settings.practice, code: sb.id, types: svc.onlineTypes(), avail: D.AVAIL, brand: sandbox.brandView(sb), areas: regions.areasFor(sb.brand.region), referral: svc.referralOptions() }));
});
// A staff invitation or reset link: /invite/<practice code>/<token>. No sign-in; the token is the key.
const invitePractice = (code) => { const sb = sandbox.get(code); if (!sb || (!auth.DEMO && !sb.live)) throw new svc.HttpError(410, "This link has expired or has already been used. Ask your practice office to send you a new one."); return sb; };
route("GET", "/api/public/:code/invite/:token", { public: true }, (req, body, user, { code, token }) => {
  limitPublic(req, "invite", 30);
  const sb = invitePractice(code);
  return sandbox.run(sb, () => ({ practice: sb.settings.practice, brand: sandbox.brandView(sb), demo: auth.DEMO, ...invites.describe(token) }));
});
route("POST", "/api/public/:code/invite/:token/password", { public: true }, (req, body, user, { code, token }) => {
  limitPublic(req, "invite", 30);
  return sandbox.run(invitePractice(code), () => invites.choosePassword(token, body.password));
});
route("POST", "/api/public/:code/invite/:token/confirm", { public: true }, (req, body, user, { code, token }) => {
  limitSignIn(req);
  const sb = invitePractice(code);
  // Not signed in here: they sign in as normal next, which proves the new password and app both work (and, in a
  // demo, doesn't replace the office's own sign-in in the same browser).
  const u = sandbox.run(sb, () => invites.confirm(token, body.code));
  return { ok: true, practice: sb.id, email: u.email, role: u.role, name: u.name };
});
route("GET", "/api/public/:code/invite/:token/demo-code", { public: true }, (req, body, user, { code, token }) => {
  if (!auth.DEMO) throw new svc.HttpError(404, "No such endpoint.");
  return sandbox.run(invitePractice(code), () => invites.demoCode(token) || { code: null, secondsLeft: 30 });
});
route("POST", "/api/public/:code/slots", { public: true }, (req, body, user, { code }) => { limitPublic(req, "slots", 60); return sandbox.run(practice(code), () => svc.publicFindSlots(body)); });
/**
 * Spam protection for the public forms, on top of the per-connection limits: a hidden "website" box that people never
 * see (bots fill every field), and a minimum time on the form (people take longer than a few seconds; scripts posting
 * straight here don't send it at all). A bot gets an ordinary-looking success and nothing is saved, so it can't learn
 * what tripped it.
 */
const looksLikeBot = (body) => !!String(body.website || "").trim() || !(Number(body.formMs) >= 3000);
route("POST", "/api/public/:code/referrals", { public: true }, (req, body, user, { code }) => {
  limitPublic(req, "refer", 10);
  if (looksLikeBot(body)) return { ok: true };
  return sandbox.run(practice(code), () => svc.submitReferral(body));
});
/**
 * The practice's test ad form, with the same spam checks as the other public forms. Connectors use /api/hooks.
 * A live practice's form is for its own office to try: it sends a thank-you email to the address typed in, so
 * left open it would let anyone send the practice's email to anyone.
 */
route("POST", "/api/public/:code/leads", { public: true }, (req, body, user, { code }) => {
  if (!auth.DEMO && !(req.auth && user && user.role === "admin" && req.auth.sb.id === String(code).toUpperCase())) throw new svc.HttpError(403, "Sign in to the office in this browser to use the test form.");
  limitPublic(req, "leads", 30);
  if (looksLikeBot(body)) return { ok: true };
  return sandbox.run(practice(code), () => leads.receive({ ...body, test: undefined }, { via: "test form" }));
});

/* ---------- Facebook leads arriving from outside: no sign-in, so each is checked by its own secret ---------- */
const hookPractice = (code) => { const sb = sandbox.get(String(code).toUpperCase()); if (!sb) throw new svc.HttpError(404, "No such practice."); return sb; };
/**
 * Zapier or Make, from the practice's Facebook Lead Ads: they post each lead to the practice's private link.
 * The key in the link (or an X-Domi-Key header) is the practice's own, from Settings, and can be changed there.
 */
route("POST", "/api/hooks/:code/leads", { public: true, raw: true }, (req, body, user, { code }) => {
  limitPublic(req, "hook", 120);
  const sb = hookPractice(code);
  const key = new URL(req.url, "http://x").searchParams.get("key") || req.headers["x-domi-key"] || "";
  if (!leads.sameSecret(key, sb.settings.leadsKey)) throw new svc.HttpError(403, "This link's key doesn't match. Copy the link again from Settings, Facebook leads.");
  return sandbox.run(sb, () => leads.receive(body, { via: "Zapier or Make" }));
});
/** Facebook's own webhook: first a one-off check that the link is ours, then a notice for each new lead. */
route("GET", "/api/hooks/:code/meta", { public: true, raw: true }, (req, body, user, { code }) => {
  const sb = hookPractice(code), q = new URL(req.url, "http://x").searchParams;
  if (q.get("hub.mode") !== "subscribe" || !leads.sameSecret(q.get("hub.verify_token") || "", sb.settings.meta.verifyToken)) throw new svc.HttpError(403, "The verify token doesn't match the one in Settings.");
  return { __text: String(q.get("hub.challenge") || "") };
});
route("POST", "/api/hooks/:code/meta", { public: true, raw: true }, (req, body, user, { code }) => {
  limitPublic(req, "meta", 240);
  const sb = hookPractice(code);
  return sandbox.run(sb, () => leads.metaNotice(req.rawBody || "", req.headers["x-hub-signature-256"] || "", body));
});
/** The office's own view of the connection: their private link and key, and whether leads are arriving. */
route("GET", "/api/leads/connection", {}, (req, body, user) => { needAdmin(user); return leads.connection(publicBase(req)); });
route("POST", "/api/leads/connection/key", {}, (req, body, user) => { needAdmin(user); return leads.newKey(user, publicBase(req)); });
route("PUT", "/api/leads/connection/meta", {}, (req, body, user) => { needAdmin(user); return leads.saveMeta(body, user, publicBase(req)); });
route("POST", "/api/leads/:id/status", {}, (req, body, user, { id }) => { needAdmin(user); return leads.setLeadStatus(id, body, user); });
route("POST", "/api/referrals/:id/accept", {}, (req, body, user, { id }) => { needAdmin(user); return svc.acceptReferral(id, body, user); });
route("POST", "/api/referrals/:id/decline", {}, (req, body, user, { id }) => { needAdmin(user); return svc.declineReferral(id, body.reason, user); });
// The cancellation link a patient's family can use instead of texting: /cancel/<practice code>/<token>.
route("GET", "/api/public/:code/visit/:token", { public: true }, (req, body, user, { code, token }) => { limitPublic(req, "visit", 30); const sb = practice(code); return sandbox.run(sb, () => ({ practice: sb.settings.practice, brand: sandbox.brandView(sb), ...svc.publicVisit(token) })); });
route("POST", "/api/public/:code/visit/:token/cancel", { public: true }, (req, body, user, { code, token }) => { limitPublic(req, "cancel", 10); return sandbox.run(practice(code), () => svc.publicCancel(token, body)); });
route("POST", "/api/public/:code/bookings", { public: true }, (req, body, user, { code }) => {
  limitPublic(req, "book", 10);
  if (looksLikeBot(body)) return { ok: true, dayLabel: "", time: "", clinician: "", when: "" };
  return sandbox.run(practice(code), () => svc.publicBook(body));
});

// Invoices: raised automatically when a visit is completed.
route("GET", "/api/invoices", {}, (req, body, user) => { needAdmin(user); return svc.invoiceList(); });
route("POST", "/api/invoices/:id/pay", {}, (req, body, user, { id }) => { needAdmin(user); return svc.payInvoice(id, String(body.method || ""), user); });
route("POST", "/api/invoices/:id/void", {}, (req, body, user, { id }) => { needAdmin(user); return svc.voidInvoice(id, user); });
route("GET", "/api/invoices/:id", {}, (req, body, user, { id }) => {
  needAdmin(user);
  const inv = svc.getInvoice(id), p = svc.getPatient(inv.patientId);
  return { ...inv, patient: { name: p.name, addr: p.addr, pc: p.pc }, practice: { name: sandbox.current().settings.practice, addr: sandbox.current().brand.phone ? null : "Sample practice, Leeds", email: sandbox.current().settings.email || "hello@practice.example", phone: sandbox.current().settings.phone || null } };
});

// Mileage and utilisation for the week, per clinician and day.
route("GET", "/api/reports/week", {}, (req, body, user) => { needAdmin(user); return svc.weekReport(); });

// Recalls: text the patient a booking link, or take them off the list.
// The address the office is using (so a custom domain is kept), unless PUBLIC_URL pins one.
const publicBase = (req) => process.env.PUBLIC_URL || (req.headers.host ? `${String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https" ? "https" : "http"}://${req.headers.host}` : process.env.RENDER_EXTERNAL_URL);
route("POST", "/api/recalls/:id/text", {}, (req, body, user, { id }) => { needAdmin(user); return svc.textRecall(id, `${publicBase(req)}/book/${sandbox.current().id}`, user); });
// Patient import: preview first (nothing saved), then commit. Office only, like every other change to patient records.
route("POST", "/api/import/preview", {}, (req, body, user) => { needAdmin(user); return svc.previewImport(body); });
route("POST", "/api/import/commit", {}, (req, body, user) => { needAdmin(user); return svc.commitImport(body, user); });
route("POST", "/api/pcse/:id/done", {}, (req, body, user, { id }) => { needAdmin(user); return svc.completePcse(id, user); });
// Diary changes to copy into Opticabase, until the two can sync. Office only.
route("GET", "/api/diary-changes", {}, (req, body, user) => { needAdmin(user); return svc.diaryChanges(); });
route("POST", "/api/diary-changes/copied", {}, (req, body, user) => { needAdmin(user); return svc.markDiaryCopied(body.ids, user); });
// The pilot: baseline, targets and what's measured each week. Office only.
route("GET", "/api/pilot", {}, (req, body, user) => { needAdmin(user); return pilot.report(); });
route("PUT", "/api/pilot", {}, (req, body, user) => { needAdmin(user); return pilot.save(body, user); });
route("PUT", "/api/pilot/week", {}, (req, body, user) => { needAdmin(user); return pilot.saveWeek(body.week, { hours: body.hours, miles: body.miles }, user); });
// PCSE pre-visit notifications: office only (the clinician's phone just shows whether one was lodged).
route("GET", "/api/pvn", {}, (req, body, user) => { needAdmin(user); return pvn.list(); });
route("POST", "/api/pvn/lodge", {}, (req, body, user) => { needAdmin(user); return svc.lodgePvn(body, user); });
route("PUT", "/api/appointments/:id/pvn", {}, (req, body, user, { id }) => { needAdmin(user); return svc.setPvnDetails(id, body, user); });
route("POST", "/api/recalls/:id/dismiss", {}, (req, body, user, { id }) => { needAdmin(user); return svc.dismissRecall(id, user); });

// A clinician's day as a map: office for anyone, a clinician for their own round. Optional proposed visit.
route("GET", "/api/route", {}, (req, body, user) => {
  const q = new URL(req.url, "http://x").searchParams;
  const cid = q.get("clinician") || user.clinicianId;
  if (user.role !== "admin" && cid !== user.clinicianId) throw new svc.HttpError(403, "That's another clinician's round.");
  const insert = q.get("pc") ? { pc: q.get("pc"), start: q.get("start"), type: q.get("type"), name: q.get("name") } : null;
  return svc.routeFor(cid, Number(q.get("day") || 0), insert);
});

// Route planning: the office sees the proposed order first, then applies it.
route("GET", "/api/route/plan", {}, (req, body, user) => { needAdmin(user); const q = new URL(req.url, "http://x").searchParams; return svc.planRoute(q.get("clinician"), Number(q.get("day") || 0)); });
route("POST", "/api/route/plan", {}, (req, body, user) => { needAdmin(user); return svc.applyRoute(body.clinicianId, Number(body.day || 0), user); });

// Tomorrow's reminders now, rather than waiting for the practice's reminder time (the demo can't wait until 17:00).
route("POST", "/api/reminders/send", {}, (req, body, user) => { needAdmin(user); sandbox.current().remindedDay = 1; return svc.sendReminders(require("./calendar").openDays(1, 1)[0], user.name); });
// Where a booking came from, and how likely it is to go ahead (the true count).
route("PUT", "/api/appointments/:id/likelihood", {}, (req, body, user, { id }) => { needAdmin(user); return svc.setLikelihood(id, body, user); });
// Confirmation calls (CC1-CC3): today's list, and recording each one.
route("GET", "/api/calls", {}, (req, body, user) => { needAdmin(user); return calls.list(); });
route("POST", "/api/calls/:id", {}, (req, body, user, { id }) => { needAdmin(user); return calls.record(id, body.stage, body.outcome, user); });

route("POST", "/api/messages/read", {}, (req, body, user) => {
  if (user.clinicianId) db.prepare("UPDATE messages SET read = 1 WHERE to_clinician_id = ?").run(user.clinicianId);
  return { ok: true };
});

// Demo only: the office plays the patient's phone. Signed-in office users, own sandbox only. Never on a live
// practice, where it would let staff write a reply as if a patient had sent it.
route("POST", "/api/demo/sms", {}, (req, body, user) => {
  if (!auth.DEMO) throw new svc.HttpError(404, "No such endpoint.");
  needAdmin(user);
  const patient = svc.getPatient(String(body.patientId || ""));
  if (!patient) throw new svc.HttpError(404, "Patient not found.");
  const text = String(body.body || "").slice(0, 300);
  if (!text.trim()) throw new svc.HttpError(400, "Write the patient's reply.");
  return svc.handleInbound(patient.phone, text);
});

// Real Twilio webhook. Only exists when Twilio is configured, and only accepts correctly signed requests.
route("POST", "/api/sms/inbound", { public: true, raw: true }, (req, body) => {
  if (provider !== "twilio") throw new svc.HttpError(404, "Inbound texts are switched off in demo mode.");
  if (!verifyTwilio(req.headers["x-twilio-signature"], new URL(req.url, "http://x").pathname, body)) throw new svc.HttpError(403, "Signature check failed.");
  const digits = String(body.From || "").replace(/\D/g, "").replace(/^44/, "0");
  // Route to the most recently active sandbox where this number has a pending offer or a booked visit.
  const sb = sandbox.all().sort((a, b) => b.lastSeen - a.lastSeen).find((s) => sandbox.run(s, () => db.prepare(
    `SELECT 1 FROM patients p WHERE replace(p.phone, ' ', '') = ? AND (
       EXISTS (SELECT 1 FROM waitlist w JOIN offers o ON o.waitlist_id = w.id WHERE w.patient_id = p.id AND o.status = 'pending')
       OR EXISTS (SELECT 1 FROM appointments a WHERE a.patient_id = p.id AND a.status = 'booked'))`).get(digits)));
  if (!sb) return { matched: false };
  return sandbox.run(sb, () => svc.handleInbound(body.From, body.Body || ""));
});

route("POST", "/api/admin/reset", {}, (req, body, user) => {
  needAdmin(user);
  const sb = sandbox.current();
  sandbox.reset(sb);
  reqLogs.delete(sb.id);
  bus.emit({ type: "reset" });
  return { ok: true };
});

/* ---------- "Under the hood" (demo only: office, own sandbox). A live practice's raw tables aren't browsable. */
const needDemo = () => { if (!auth.DEMO) throw new svc.HttpError(404, "No such endpoint."); };
route("GET", "/api/debug/overview", {}, (req, body, user) => {
  needDemo(); needAdmin(user);
  const sb = sandbox.current();
  const counts = Object.fromEntries(TABLES.map((t) => [t, db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n]));
  return {
    sandbox: sb.id, now: sandbox.stamp(), counts, routing: travel.routingStatus(), sessions: sessionList(req.auth), requests: reqLogs.get(sb.id) || [], liveConnections: bus.connections(sb.id),
    events: bus.recentFor(sb.id).filter((e) => e.type !== "http").slice(0, 40),
    audit: db.prepare("SELECT * FROM audit ORDER BY id DESC LIMIT 60").all().map((r) => ({ ...r })),
    offers: db.prepare("SELECT o.*, p.name AS patient FROM offers o JOIN waitlist w ON w.id = o.waitlist_id JOIN patients p ON p.id = w.patient_id ORDER BY o.id DESC").all().map((r) => ({ ...r })),
    settings: sandbox.publicSettings(sb.settings), smsProvider: provider, activeDemos: sandbox.all().length, node: process.version,
    routes: routes.map((r) => ({ method: r.method, path: r.pattern, auth: r.public ? "public" : "signed in" })),
  };
});
route("GET", "/api/debug/table/:name", {}, (req, body, user, { name }) => {
  needDemo(); needAdmin(user);
  if (!TABLES.includes(name)) throw new svc.HttpError(404, "No such table.");
  const cols = db.prepare(`PRAGMA table_info(${name})`).all().map((c) => ({ name: c.name, type: c.type, pk: !!c.pk }));
  const rows = db.prepare(`SELECT * FROM ${name} ORDER BY rowid DESC LIMIT 50`).all().map((r) => ({ ...r }));
  // Never send secrets to the browser, even to the office: show that they exist, not what they are.
  if (name === "users") rows.forEach((r) => { r.pass_hash = r.pass_hash.split("$").slice(0, 4).join("$") + "$…"; r.totp_secret = "•••• (hidden)"; });
  // Staff emails carry their one-time sign-in link: never shown here, even though the stored copy is redacted.
  if (name === "emails") rows.forEach((r) => { if (/^staff-/.test(r.kind)) r.body = "•••• (a sign-in link: hidden)"; });
  if (name === "invites") rows.forEach((r) => { r.id = r.id.slice(0, 6) + "… (a hash of the link)"; if (r.pass_hash) r.pass_hash = "•••• (hidden)"; if (r.totp_secret) r.totp_secret = "•••• (hidden)"; });
  return { name, cols, rows };
});

/* ---------- Static files ---------- */
const zlib = require("node:zlib");
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".webmanifest": "application/manifest+json", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8" };
const TEXT = new Set([".html", ".js", ".css", ".svg", ".json", ".webmanifest", ".txt"]);
// The Domi website: the demo's privacy policy and terms live there, so there's only ever one version of each.
const SITE = (process.env.MARKETING_URL || "https://domi.ysbdesigns.uk/").replace(/\/?$/, "/");
// Cloudflare Web Analytics (cookieless), when a token is set. Never on the cancellation page: its address holds the
// private token that cancels a visit, and analytics records page addresses.
const BEACON = /^[0-9a-f]{32}$/i.test(process.env.CF_BEACON_TOKEN || "") ? process.env.CF_BEACON_TOKEN : null;
const beaconTag = BEACON ? `<script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='{"token": "${BEACON}"}'></script>` : "";
const gzipped = new Map(); // etag -> compressed bytes, so each file is compressed once
function serveStatic(req, res) {
  let p;
  try { p = decodeURIComponent(new URL(req.url, "http://x").pathname); } catch { res.writeHead(400, { "Content-Type": "text/plain" }); return res.end("Bad request"); }
  if (p === "/privacy" || p === "/privacy/") { res.writeHead(301, { Location: SITE + "privacy/" }); return res.end(); }
  if (p === "/terms" || p === "/terms/") { res.writeHead(301, { Location: SITE + "terms/" }); return res.end(); }
  if (p === "/") p = "/index.html";
  if (p === "/under-the-hood") p = "/under-the-hood.html";
  if (p === "/brand") p = "/brand.html";
  if (p.startsWith("/refer/")) p = "/refer.html";
  if (p.startsWith("/ad-form/")) p = "/ad-form.html"; // the practice's test ad form: /ad-form/<practice code> // the practice's referral form: /refer/<practice code>
  if (p.startsWith("/invite/")) p = "/invite.html"; // a staff invitation or sign-in reset: /invite/<practice code>/<token>
  if (p.startsWith("/cancel/")) p = "/cancel.html"; // a visit's cancellation link: /cancel/<practice code>/<token>
  if (p === "/book" || p.startsWith("/book/")) p = "/book.html"; // a practice's patient booking page: /book/<practice code>
  const file = path.join(PUBLIC, path.normalize(p));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  // HTML, CSS and JS revalidate on every load (cheap 304s via ETag) so a redeploy shows up immediately;
  // fonts and images rarely change and can be cached for a day.
  fs.readFile(file, (err, data) => {
    let status = 200, ext = path.extname(file);
    if (err) {
      // Anything that isn't a page gets a plain 404; a page address gets the friendly one.
      if (ext && ext !== ".html") { res.writeHead(404, { "Content-Type": "text/plain" }); return res.end("Not found"); }
      status = 404; ext = ".html"; data = fs.readFileSync(path.join(PUBLIC, "404.html"));
    }
    if (ext === ".html") {
      data = Buffer.from(data.toString("utf8")
        .replace("<!--ANALYTICS-->", p === "/cancel.html" || p === "/invite.html" ? "" : beaconTag) // their addresses hold private tokens
        .split("%%ORIGIN%%").join(publicBase(req).replace(/"/g, ""))
        .split("%%SITE%%").join(SITE));
    }
    const etag = '"' + crypto.createHash("sha1").update(data).digest("base64url").slice(0, 16) + '"';
    if (status === 200 && req.headers["if-none-match"] === etag) { res.writeHead(304, { ETag: etag }); return res.end(); }
    const headers = { "Content-Type": MIME[ext] || "application/octet-stream", "Cache-Control": status === 404 ? "no-store" : [".woff2", ".svg", ".png", ".jpg"].includes(ext) ? "public, max-age=86400" : "no-cache", ETag: etag, Vary: "Accept-Encoding" };
    // Text files are sent gzipped (often 70-80% smaller), which matters most on a clinician's phone signal.
    if (TEXT.has(ext) && data.length > 1024 && /\bgzip\b/.test(req.headers["accept-encoding"] || "")) {
      if (!gzipped.has(etag)) { if (gzipped.size > 200) gzipped.clear(); gzipped.set(etag, zlib.gzipSync(data, { level: 9 })); }
      data = gzipped.get(etag); headers["Content-Encoding"] = "gzip";
    }
    res.writeHead(status, headers);
    res.end(data);
  });
}

/* ---------- Server ---------- */
// Live-update streams per session, so signing out (or being signed out by the office) cuts them off at once.
const liveStreams = new Map();
auth.onRevoke((s, why) => {
  for (const res of liveStreams.get(s.id) || []) {
    if (!res.writableEnded) { res.write(`event: signedout\ndata: ${JSON.stringify({ why })}\n\n`); res.end(); }
  }
  liveStreams.delete(s.id);
});
const sameOrigin = (req) => { const o = req.headers.origin; if (!o) return true; try { return new URL(o).host === req.headers.host; } catch { return false; } };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  // Always HTTPS: behind Render's proxy a plain-HTTP request is sent to the HTTPS address, and browsers are told to
  // use HTTPS from then on (HSTS). Local development (localhost) is left alone.
  const proto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(req.headers.host || "");
  if (proto === "http" && !local) { res.writeHead(301, { Location: `https://${req.headers.host}${req.url}` }); return res.end(); }
  if (proto === "https") res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY"); // the app can't be framed by another site (clickjacking)
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Robots-Tag", "noindex, nofollow"); // a demo with sample patients should never show up in search
  if (!url.pathname.startsWith("/api/")) return serveStatic(req, res);

  if (url.pathname === "/api/events") {
    const who = verify(req); // EventSource sends the session cookie
    if (!who) return send(res, 401, { error: "Sign in again." });
    // X-Accel-Buffering stops hosting proxies (Render, nginx) holding events back
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.write(`event: hello\ndata: ${JSON.stringify({ user: who.user.name, sandbox: who.sb.id })}\n\n`);
    // An open live connection counts as activity; it also ends as soon as the session does.
    const ping = setInterval(() => { if (!auth.sessionById(who.session.id)) return res.end(); who.sb.lastSeen = Date.now(); res.write(": ping\n\n"); }, 25000);
    const streams = liveStreams.get(who.session.id) || new Set(); streams.add(res); liveStreams.set(who.session.id, streams);
    res.on("close", () => { clearInterval(ping); streams.delete(res); if (!streams.size) liveStreams.delete(who.session.id); });
    return bus.subscribe(res, who.user, who.sb.id);
  }

  const t0 = process.hrtime.bigint();
  let status = 200;
  let who = null;
  try {
    const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
    if (!r) throw new svc.HttpError(404, "No such endpoint.");
    const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(url.pathname.match(r.re)[i + 1])]));
    // Cross-site request forgery: changes need a header that a form on another site can't add, and,
    // when the browser says where the request came from, it must be this site.
    if (req.method !== "GET" && !r.raw && (req.headers["x-domi"] !== "1" || !sameOrigin(req))) throw new svc.HttpError(403, "Request blocked: it didn't come from the app.");
    who = verify(req);
    if (!r.public && !who) throw new svc.HttpError(401, "You've been signed out. Sign in again.");
    const body = req.method === "GET" ? {} : await readBody(req, url.pathname.startsWith("/api/import/") ? 4e6 : 1e5); // a spreadsheet of patients is bigger than any other request
    req.auth = who; req.cookies = [];
    if (who) who.sb.base = publicBase(req); // links in texts (cancellation links) point back at this address
    const data = who && !r.raw ? await sandbox.run(who.sb, () => r.handler(req, body, who.user, params)) : await r.handler(req, body, who && who.user, params);
    // A live practice answers only once the change is saved in Postgres.
    await sandbox.settle().catch(() => { throw new svc.HttpError(503, "That couldn't be saved just now. Please try again in a moment."); });
    send(res, 200, data, req.cookies);
  } catch (err) {
    status = err.status || 500;
    if (status === 500) console.error(err);
    if (status === 401 && url.pathname.startsWith("/api/auth/")) noteFailure(req);
    send(res, status, { error: status === 500 ? "Something went wrong on the server." : err.message, ...(status < 500 && err.extra ? err.extra : {}) });
  } finally {
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    if (who && !url.pathname.startsWith("/api/debug")) {
      logRequest(who.sb, { method: req.method, path: url.pathname, status, ms: Math.round(ms * 10) / 10, who: who.user.name, time: sandbox.stamp(who.sb) });
    }
  }
});

const sweeper = setInterval(() => {
  for (const sb of sandbox.all()) if (sb.live) { try { require("./live").roll(sb); } catch (e) { console.error("calendar roll failed", sb.id, e); } }
  for (const sb of sandbox.all()) sandbox.run(sb, () => { try { svc.sweepExpired(); svc.sweepReminders(); svc.sweepRecalls(); } catch (e) { console.error("sweep failed", sb.id, e); } });
  sandbox.settle().catch(() => {}); // live practices: save anything the sweeps or late text receipts changed
}, 5000);
sweeper.unref();

function start(port = PORT) {
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

if (require.main === module) {
  // With DATABASE_URL set, the real practices kept in Postgres are opened first. Demos work either way.
  require("./live").start().then((opened) => {
    if (opened.length) console.log(`Live practices open: ${opened.map((sb) => sb.id).join(", ")}`);
    return start();
  }).then(() => {
    console.log(`Domi ${process.env.DEMO_MODE === "0" ? "live" : "demo"} running on http://localhost:${PORT}`);
    console.log(`  Under the hood:  http://localhost:${PORT}/under-the-hood`);
    console.log(`  SMS provider:    ${provider}${provider === "outbox" ? " (set TWILIO_* env vars to send real texts)" : ""}`);
  });
  // A deploy stops this machine (Fly sends SIGINT, others SIGTERM): stop taking requests, finish writing every
  // change to Postgres and the sign-ins, then exit. Without this a change made just before a deploy could be lost.
  let stopping = false;
  const shutdown = (sig) => {
    if (stopping) return;
    stopping = true;
    console.log(`${sig}: saving and stopping`);
    const force = setTimeout(() => { console.error("Stopped before everything was saved"); process.exit(1); }, 8000);
    force.unref();
    server.close();
    require("./live").stop().then(() => process.exit(0), (e) => { console.error("Couldn't finish saving:", e.message); process.exit(1); });
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

module.exports = { server, start };
