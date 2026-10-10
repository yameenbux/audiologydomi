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
const bus = require("./bus");
const { provider, verifyTwilio } = require("./notify");

const PORT = Number(process.env.PORT || 3000);
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const PUBLIC = path.join(__dirname, "..", "public");

/* ---------- Sessions: HMAC-signed tokens carrying the user and their sandbox ---------- */
const sign = (uid, sid) => {
  const p = Buffer.from(JSON.stringify({ uid, sid, iat: Date.now() })).toString("base64url");
  return p + "." + crypto.createHmac("sha256", SECRET).update(p).digest("base64url");
};
function verify(tok) {
  if (!tok) return null;
  const [p, s] = String(tok).split(".");
  if (!p || !s) return null;
  const good = crypto.createHmac("sha256", SECRET).update(p).digest("base64url");
  if (s.length !== good.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(good))) return null;
  let claims;
  try { claims = JSON.parse(Buffer.from(p, "base64url").toString()); } catch { return null; }
  if (Date.now() - claims.iat > 12 * 3600e3) return null;
  const sb = sandbox.get(claims.sid);
  const u = USERS.find((x) => x.id === claims.uid);
  if (!sb || !u) return null;
  return { sb, user: { id: u.id, name: u.name, role: u.role, clinicianId: u.clinicianId } };
}

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

const send = (res, status, data) => {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
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
  demoUsers: USERS.map(({ id, name, role, title, color }) => ({ id, name, role, title, color })),
}));

// Sign in. Without a sandbox code this starts a fresh private demo; with one it joins it (laptop + phone).
route("POST", "/api/login", { public: true }, (req, body) => {
  const u = USERS.find((x) => x.id === String(body.userId || ""));
  if (!u) throw new svc.HttpError(401, "Unknown user.");
  let sb = null;
  if (body.sandbox) {
    sb = sandbox.get(body.sandbox);
    if (!sb) throw new svc.HttpError(404, "That demo code has expired. Start a new demo instead.");
  } else sb = sandbox.create();
  sandbox.run(sb, () => svc.audit(u.name, "auth.login", u.id, `${u.role} joined demo ${sb.id}`));
  return { token: sign(u.id, sb.id), sandbox: sb.id, user: { id: u.id, name: u.name, role: u.role, clinicianId: u.clinicianId } };
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
    user, sandbox: sb.id, now: sandbox.nowMin(), clinicians: isAdmin ? clinicians : [me], appts, patients, messages, waitlist, offers,
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
  svc.audit(user.name, "settings.update", "settings", JSON.stringify(st));
  bus.emit({ type: "settings.updated", settings: st });
  return st;
});

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
    sandbox: sb.id, now: sandbox.stamp(), counts, routing: travel.routingStatus(), requests: reqLogs.get(sb.id) || [], liveConnections: bus.connections(sb.id),
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
  return { name, cols, rows: db.prepare(`SELECT * FROM ${name} ORDER BY rowid DESC LIMIT 50`).all().map((r) => ({ ...r })) };
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
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Robots-Tag", "noindex, nofollow"); // a demo with sample patients should never show up in search
  if (!url.pathname.startsWith("/api/")) return serveStatic(req, res);

  if (url.pathname === "/api/events") {
    const auth = verify(url.searchParams.get("token")); // EventSource cannot send headers
    if (!auth) return send(res, 401, { error: "Sign in again." });
    // X-Accel-Buffering stops hosting proxies (Render, nginx) holding events back
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.write(`event: hello\ndata: ${JSON.stringify({ user: auth.user.name, sandbox: auth.sb.id })}\n\n`);
    const ping = setInterval(() => { auth.sb.lastSeen = Date.now(); res.write(": ping\n\n"); }, 25000);
    res.on("close", () => clearInterval(ping));
    return bus.subscribe(res, auth.user, auth.sb.id);
  }

  const t0 = process.hrtime.bigint();
  let status = 200;
  let auth = null;
  try {
    const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
    if (!r) throw new svc.HttpError(404, "No such endpoint.");
    const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(url.pathname.match(r.re)[i + 1])]));
    auth = verify((req.headers.authorization || "").replace(/^Bearer /, ""));
    if (!r.public && !auth) throw new svc.HttpError(401, "Your demo session has ended. Sign in again.");
    const body = req.method === "GET" ? {} : await readBody(req);
    const data = auth && !r.raw ? await sandbox.run(auth.sb, () => r.handler(req, body, auth.user, params)) : await r.handler(req, body, auth && auth.user, params);
    send(res, 200, data);
  } catch (err) {
    status = err.status || 500;
    if (status === 500) console.error(err);
    send(res, status, { error: status === 500 ? "Something went wrong on the server." : err.message });
  } finally {
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    if (auth && !url.pathname.startsWith("/api/debug")) {
      logRequest(auth.sb, { method: req.method, path: url.pathname, status, ms: Math.round(ms * 10) / 10, who: auth.user.name, time: sandbox.stamp(auth.sb) });
    }
  }
});

const sweeper = setInterval(() => {
  for (const sb of sandbox.all()) sandbox.run(sb, () => { try { svc.sweepExpired(); } catch (e) { console.error("sweep failed", sb.id, e); } });
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
