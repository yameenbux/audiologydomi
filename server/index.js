"use strict";
// HTTP API + static frontend. Zero dependencies: node:http, node:sqlite, node:crypto.
// Every request runs inside the caller's sandbox (see sandbox.js), so visitors never share data.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const sandbox = require("./sandbox");
const { db, map, TABLES, USERS } = require("./db");
const D = require("./domain");
const travel = require("./travel");
const svc = require("./service");
const auth = require("./auth");
const bus = require("./bus");
const { provider, verifyTwilio } = require("./notify");

const PORT = Number(process.env.PORT || 3000);
const PUBLIC = path.join(__dirname, "..", "public");

/* ---------- Sessions: server-side, referenced by an HttpOnly cookie (see auth.js) ---------- */
const pub = (u) => ({ id: u.id, name: u.name, role: u.role, clinicianId: u.clinicianId });
/** Who is calling: their session, their demo, the person signed in, and who they're viewing as. */
function verify(req) {
  const s = auth.getSession(auth.readCookie(req));
  if (!s) return null;
  const sb = sandbox.get(s.sbId);
  const real = USERS.find((x) => x.id === s.uid), eff = USERS.find((x) => x.id === (s.actingAs || s.uid));
  if (!sb || !real || !eff) { auth.endSession(s.id, "demo expired"); return null; }
  sb.lastSeen = Date.now();
  return { sb, session: s, real: pub(real), user: pub(eff) };
}
// Short public handle for a session, so the office can see and end sessions without ever seeing a token.
const handle = (s) => crypto.createHash("sha256").update(s.id).digest("base64url").slice(0, 12);

// Per-IP limit on failed sign-in attempts, on top of the per-account lockout. Successes don't count,
// so a busy office behind one connection is never blocked.
const attempts = new Map();
// The first X-Forwarded-For entry can be forged, so this limit can be dodged, but it never lumps every
// visitor behind one proxy address into a single bucket (which would let one attacker block everyone).
// The per-account lockout is the real protection; this is a second layer.
const ipOf = (req) => String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
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
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...(cookies.length ? { "Set-Cookie": cookies } : {}) });
  res.end(JSON.stringify(data));
};
async function readBody(req) {
  let raw = "";
  for await (const chunk of req) { raw += chunk; if (raw.length > 1e5) throw new svc.HttpError(413, "Request too large."); }
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

route("GET", "/api/meta", { public: true }, () => ({
  types: D.TYPES, prio: D.PRIO, avail: D.AVAIL, reasons: D.REASONS, dayStart: D.DAY_START, dayEnd: D.DAY_END, days: D.DAYS, smsProvider: provider, routing: travel.routingStatus().provider,
  demoUsers: USERS.map(({ id, name, role, title, color, email }) => ({ id, name, role, title, color, email })),
  demo: auth.DEMO ? { password: auth.DEMO_PASSWORD } : null,
}));

/* ---------- Sign-in ---------- */
// Start a private demo (a practice of its own), or check a code to join one. No account is signed in yet.
route("POST", "/api/demo/start", { public: true }, (req, body) => {
  if (body.join) {
    const sb = sandbox.get(String(body.join));
    if (!sb) throw new svc.HttpError(404, "That demo code has expired. Start a new demo instead.");
    return { sandbox: sb.id };
  }
  return { sandbox: sandbox.create().id };
});

// Step 1: email and password. Returns a short-lived challenge for step 2; nothing is signed in yet.
route("POST", "/api/auth/password", { public: true }, async (req, body) => {
  limitSignIn(req);
  const sb = sandbox.get(String(body.sandbox || ""));
  if (!sb) throw new svc.HttpError(404, "That demo has expired. Start a new one.");
  return sandbox.run(sb, async () => {
    const email = String(body.email || "").trim().toLowerCase();
    const row = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
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
    db.prepare("UPDATE users SET failed = 0 WHERE id = ?").run(row.id);
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
    const step = auth.matchTotp(row.totp_secret, body.code, row.totp_step);
    if (step == null) {
      c.tries++;
      svc.audit(row.name, "auth.failed", row.id, `Wrong two-factor code (${c.tries} of ${auth.CHALLENGE_TRIES})`);
      if (c.tries >= auth.CHALLENGE_TRIES) c.expires = 0; // start again from the password
      throw new svc.HttpError(401, c.tries >= auth.CHALLENGE_TRIES ? "Too many wrong codes. Enter your password again." : "That code isn't right, or it's already been used. Codes change every 30 seconds.");
    }
    db.prepare("UPDATE users SET totp_step = ? WHERE id = ?").run(step, row.id);
    c.expires = 0; // used
    const s = auth.createSession({ sbId: sb.id, uid: row.id, kind: "password", ua: req.headers["user-agent"] });
    req.cookies.push(auth.sessionCookie(req, s.id));
    svc.audit(row.name, "auth.login", row.id, "Signed in with password and two-factor code");
    return { sandbox: sb.id, user: pub(USERS.find((u) => u.id === row.id)) };
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
  const target = USERS.find((u) => u.id === String(body.userId || ""));
  if (!target) throw new svc.HttpError(400, "Unknown user.");
  req.auth.session.actingAs = target.id === req.auth.real.id ? null : target.id;
  if (target.id !== req.auth.real.id) svc.audit(req.auth.real.name, "auth.view-as", target.id, `Viewing the app as ${target.name}`);
  return { user: pub(target) };
});

// Demo only: a single-use link (shown as a QR code) that signs a phone in as a clinician, valid 10 minutes.
route("POST", "/api/auth/pair", {}, (req, body) => {
  if (!auth.DEMO) throw new svc.HttpError(404, "No such endpoint.");
  if (req.auth.real.role !== "admin") throw new svc.HttpError(403, "Office staff only.");
  const target = USERS.find((u) => u.id === String(body.userId || "") && u.role === "clinician");
  if (!target) throw new svc.HttpError(400, "Choose a clinician.");
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
  req.cookies.push(auth.sessionCookie(req, s.id));
  const u = USERS.find((x) => x.id === p.uid);
  sandbox.run(sb, () => svc.audit(u.name, "auth.login", u.id, "Signed in on a phone with a one-time link from the office"));
  return { sandbox: sb.id, user: pub(u) };
});

// Signed-in devices in this practice, and remote sign-out (a lost phone).
const sessionList = (who) => auth.sessionsFor(who.sb.id).map((s) => ({
  id: handle(s), name: USERS.find((u) => u.id === s.uid).name, kind: s.kind, created: s.created, lastSeen: s.lastSeen,
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
  const u = USERS.find((x) => x.id === s.uid);
  svc.audit(req.auth.real.name, "auth.revoke", u.id, `Signed ${u.name} out remotely`);
  return { ok: true };
});

route("GET", "/api/state", {}, (req, body, user) => {
  const clinicians = db.prepare("SELECT * FROM clinicians ORDER BY id").all().map(map.clinician);
  const isAdmin = user.role === "admin";
  const appts = (isAdmin ? db.prepare("SELECT * FROM appointments ORDER BY start_min").all() : db.prepare("SELECT * FROM appointments WHERE clinician_id = ? ORDER BY start_min").all(user.clinicianId)).map(map.appt);
  const me = !isAdmin && clinicians.find((c) => c.id === user.clinicianId);
  const patients = db.prepare("SELECT * FROM patients ORDER BY name").all().map(map.patient)
    .filter((p) => isAdmin || appts.some((a) => a.patientId === p.id) || me.patch.includes(D.district(p.pc)));
  const messages = (isAdmin ? db.prepare("SELECT * FROM messages ORDER BY id DESC LIMIT 100").all()
    : db.prepare("SELECT * FROM messages WHERE to_clinician_id = ? OR from_clinician_id = ? ORDER BY id DESC").all(user.clinicianId, user.clinicianId)).map(map.msg);
  const waitlist = isAdmin ? db.prepare("SELECT * FROM waitlist ORDER BY added_seq").all().map(map.wait) : [];
  const offers = isAdmin ? db.prepare("SELECT * FROM offers WHERE status = 'pending'").all().map((o) => ({ ...o })) : [];
  const sb = sandbox.current();
  return {
    user, signedInAs: req.auth.real, sandbox: sb.id, now: sandbox.nowMin(), clinicians: isAdmin ? clinicians : [me], appts, patients, messages, waitlist, offers,
    metrics: isAdmin ? svc.metrics() : null, settings: sb.settings,
  };
});

// `background=1` is the app refreshing after a live update: not a person opening the record, so not audited.
route("GET", "/api/patients/:id", {}, (req, body, user, { id }) => {
  if (!clinicianCanSee(user, id)) throw new svc.HttpError(403, "This patient isn't on your round or in your area.");
  const p = svc.getPatient(id);
  if (!p) throw new svc.HttpError(404, "Patient not found.");
  if (new URL(req.url, "http://x").searchParams.get("background") !== "1") svc.audit(user.name, "patient.view", id, p.name);
  return { ...p, history: db.prepare("SELECT * FROM notes WHERE patient_id = ? ORDER BY id DESC").all(id).map(map.note) };
});

route("POST", "/api/patients/:id/notes", {}, (req, body, user, { id }) => {
  if (!clinicianCanSee(user, id)) throw new svc.HttpError(403, "This patient isn't on your round or in your area.");
  return svc.tx(() => svc.addNote(id, body.body, user));
});

route("POST", "/api/appointments/:id/status", {}, (req, body, user, { id }) => svc.setStatus(id, body.status, user));

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

// Booking: ranked slots across every round for one patient, then book the chosen one.
route("POST", "/api/slots", {}, (req, body, user) => { needAdmin(user); return svc.findSlots(body); });
route("POST", "/api/bookings", {}, (req, body, user) => { needAdmin(user); return svc.bookVisit(body, user); });

route("PUT", "/api/settings", {}, (req, body, user) => {
  needAdmin(user);
  const st = sandbox.current().settings;
  if (body.mode === "offer" || body.mode === "instant") st.mode = body.mode;
  if (Number(body.offerMinutes) >= 1 && Number(body.offerMinutes) <= 240) st.offerMinutes = Number(body.offerMinutes);
  if (body.fee !== undefined && Number(body.fee) >= 0 && Number(body.fee) <= 2000) st.fee = Math.round(Number(body.fee));
  if (typeof body.reminders === "boolean") st.reminders = body.reminders;
  if (Number(body.reminderAt) >= 8 * 60 && Number(body.reminderAt) <= 21 * 60) st.reminderAt = Math.round(Number(body.reminderAt));
  svc.audit(user.name, "settings.update", "settings", JSON.stringify(st));
  bus.emit({ type: "settings.updated", settings: st });
  return st;
});

// A clinician's day as a map: office for anyone, a clinician for their own round. Optional proposed visit.
route("GET", "/api/route", {}, (req, body, user) => {
  const q = new URL(req.url, "http://x").searchParams;
  const cid = q.get("clinician") || user.clinicianId;
  if (user.role !== "admin" && cid !== user.clinicianId) throw new svc.HttpError(403, "That's another clinician's round.");
  const insert = q.get("pc") ? { pc: q.get("pc"), start: q.get("start"), type: q.get("type"), name: q.get("name") } : null;
  return svc.routeFor(cid, Number(q.get("day") || 0), insert);
});

// Tomorrow's reminders now, rather than waiting for the practice's reminder time (the demo can't wait until 17:00).
route("POST", "/api/reminders/send", {}, (req, body, user) => { needAdmin(user); sandbox.current().remindedDay = 1; return svc.sendReminders(1, user.name); });

route("POST", "/api/messages/read", {}, (req, body, user) => {
  if (user.clinicianId) db.prepare("UPDATE messages SET read = 1 WHERE to_clinician_id = ?").run(user.clinicianId);
  return { ok: true };
});

// Demo only: the office plays the patient's phone. Signed-in office users, own sandbox only.
route("POST", "/api/demo/sms", {}, (req, body, user) => {
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

/* ---------- "Under the hood" (office only, own sandbox) ---------- */
route("GET", "/api/debug/overview", {}, (req, body, user) => {
  needAdmin(user);
  const sb = sandbox.current();
  const counts = Object.fromEntries(TABLES.map((t) => [t, db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n]));
  return {
    sandbox: sb.id, now: sandbox.stamp(), counts, routing: travel.routingStatus(), sessions: sessionList(req.auth), requests: reqLogs.get(sb.id) || [], liveConnections: bus.connections(sb.id),
    events: bus.recentFor(sb.id).filter((e) => e.type !== "http").slice(0, 40),
    audit: db.prepare("SELECT * FROM audit ORDER BY id DESC LIMIT 60").all().map((r) => ({ ...r })),
    offers: db.prepare("SELECT o.*, p.name AS patient FROM offers o JOIN waitlist w ON w.id = o.waitlist_id JOIN patients p ON p.id = w.patient_id ORDER BY o.id DESC").all().map((r) => ({ ...r })),
    settings: sb.settings, smsProvider: provider, activeDemos: sandbox.all().length, node: process.version,
    routes: routes.map((r) => ({ method: r.method, path: r.pattern, auth: r.public ? "public" : "signed in" })),
  };
});
route("GET", "/api/debug/table/:name", {}, (req, body, user, { name }) => {
  needAdmin(user);
  if (!TABLES.includes(name)) throw new svc.HttpError(404, "No such table.");
  const cols = db.prepare(`PRAGMA table_info(${name})`).all().map((c) => ({ name: c.name, type: c.type, pk: !!c.pk }));
  const rows = db.prepare(`SELECT * FROM ${name} ORDER BY rowid DESC LIMIT 50`).all().map((r) => ({ ...r }));
  // Never send secrets to the browser, even to the office: show that they exist, not what they are.
  if (name === "users") rows.forEach((r) => { r.pass_hash = r.pass_hash.split("$").slice(0, 4).join("$") + "$…"; r.totp_secret = "•••• (hidden)"; });
  return { name, cols, rows };
});

/* ---------- Static files ---------- */
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json", ".png": "image/png", ".webmanifest": "application/manifest+json", ".woff2": "font/woff2" };
function serveStatic(req, res) {
  let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (p === "/") p = "/index.html";
  if (p === "/under-the-hood") p = "/under-the-hood.html";
  if (p === "/brand") p = "/brand.html";
  const file = path.join(PUBLIC, path.normalize(p));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  // HTML, CSS and JS revalidate on every load (cheap 304s via ETag) so a redeploy shows up immediately;
  // fonts and images rarely change and can be cached for a day.
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { "Content-Type": "text/plain" }); return res.end("Not found"); }
    const etag = '"' + crypto.createHash("sha1").update(data).digest("base64url").slice(0, 16) + '"';
    if (req.headers["if-none-match"] === etag) { res.writeHead(304, { ETag: etag }); return res.end(); }
    res.setHeader("ETag", etag);
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream", "Cache-Control": [".woff2", ".svg", ".png"].includes(path.extname(file)) ? "public, max-age=86400" : "no-cache" });
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
  res.setHeader("X-Content-Type-Options", "nosniff");
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
    const ping = setInterval(() => { if (!auth.getSession(who.session.id)) return res.end(); who.sb.lastSeen = Date.now(); res.write(": ping\n\n"); }, 25000);
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
    const body = req.method === "GET" ? {} : await readBody(req);
    req.auth = who; req.cookies = [];
    const data = who && !r.raw ? await sandbox.run(who.sb, () => r.handler(req, body, who.user, params)) : await r.handler(req, body, who && who.user, params);
    send(res, 200, data, req.cookies);
  } catch (err) {
    status = err.status || 500;
    if (status === 500) console.error(err);
    if (status === 401 && url.pathname.startsWith("/api/auth/")) noteFailure(req);
    send(res, status, { error: status === 500 ? "Something went wrong on the server." : err.message });
  } finally {
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    if (who && !url.pathname.startsWith("/api/debug")) {
      logRequest(who.sb, { method: req.method, path: url.pathname, status, ms: Math.round(ms * 10) / 10, who: who.user.name, time: sandbox.stamp(who.sb) });
    }
  }
});

const sweeper = setInterval(() => {
  for (const sb of sandbox.all()) sandbox.run(sb, () => { try { svc.sweepExpired(); svc.sweepReminders(); } catch (e) { console.error("sweep failed", sb.id, e); } });
}, 5000);
sweeper.unref();

function start(port = PORT) {
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

if (require.main === module) {
  start().then(() => {
    console.log(`Domi Hearing demo running on http://localhost:${PORT}`);
    console.log(`  Under the hood:  http://localhost:${PORT}/under-the-hood`);
    console.log(`  SMS provider:    ${provider}${provider === "outbox" ? " (set TWILIO_* env vars to send real texts)" : ""}`);
  });
}

module.exports = { server, start };
