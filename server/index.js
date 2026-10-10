"use strict";
// HTTP API + static frontend. Zero dependencies: node:http, node:sqlite, node:crypto.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { db, reset, map, TABLES, FILE } = require("./db");
const D = require("./domain");
const svc = require("./service");
const bus = require("./bus");
const { provider } = require("./notify");

const PORT = Number(process.env.PORT || 3000);
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const PUBLIC = path.join(__dirname, "..", "public");
const DEMO_NOW = 10 * 60 + 20; // the demo diary is frozen at 10:20 so the story is the same every time

/* ---------- Auth: signed tokens. Demo sign-in picks a user; production would use passwords + 2FA. ---------- */
const sign = (uid) => { const p = Buffer.from(JSON.stringify({ uid, iat: Date.now() })).toString("base64url"); return p + "." + crypto.createHmac("sha256", SECRET).update(p).digest("base64url"); };
function verify(tok) {
  if (!tok) return null;
  const [p, s] = String(tok).split(".");
  if (!p || !s) return null;
  const good = crypto.createHmac("sha256", SECRET).update(p).digest("base64url");
  if (s.length !== good.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(good))) return null;
  const { uid, iat } = JSON.parse(Buffer.from(p, "base64url").toString());
  if (Date.now() - iat > 12 * 3600e3) return null; // a working day
  const u = db.prepare("SELECT * FROM users WHERE id = ?").get(uid);
  return u && { id: u.id, name: u.name, role: u.role, clinicianId: u.clinician_id };
}

/* ---------- Request log for the "Under the hood" page ---------- */
const reqLog = [];
function logRequest(entry) {
  reqLog.unshift(entry);
  reqLog.length = Math.min(reqLog.length, 80);
  bus.emit({ type: "http", ...entry });
}

/* ---------- Routing ---------- */
const routes = [];
const route = (method, pattern, opts, handler) => {
  const keys = [];
  const re = new RegExp("^" + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), "([^/]+)")) + "$");
  routes.push({ method, re, keys, handler, ...opts });
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
  types: D.TYPES, prio: D.PRIO, avail: D.AVAIL, reasons: D.REASONS, dayStart: D.DAY_START, dayEnd: D.DAY_END, now: DEMO_NOW,
  smsProvider: provider,
  demoUsers: db.prepare("SELECT u.id, u.name, u.role, c.role AS title, c.color FROM users u LEFT JOIN clinicians c ON c.id = u.clinician_id ORDER BY u.role, u.name").all().map((r) => ({ ...r })),
}));

route("POST", "/api/login", { public: true }, (req, body) => {
  const u = db.prepare("SELECT * FROM users WHERE id = ?").get(String(body.userId || ""));
  if (!u) throw new svc.HttpError(401, "Unknown user.");
  svc.audit(u.name, "auth.login", u.id, u.role);
  return { token: sign(u.id), user: { id: u.id, name: u.name, role: u.role, clinicianId: u.clinician_id } };
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
  const waitlist = isAdmin ? db.prepare("SELECT * FROM waitlist ORDER BY added_at, id").all().map(map.wait) : [];
  const offers = isAdmin ? db.prepare("SELECT * FROM offers WHERE status = 'pending'").all().map((o) => ({ ...o })) : [];
  const refilled = db.prepare("SELECT COUNT(*) AS n FROM appointments WHERE moved = 1").get().n;
  return { user, clinicians: isAdmin ? clinicians : [me], appts, patients, messages, waitlist, offers, refilled, settings: svc.settings };
});

route("GET", "/api/patients/:id", {}, (req, body, user, { id }) => {
  if (!clinicianCanSee(user, id)) throw new svc.HttpError(403, "This patient isn't on your round or in your area.");
  const p = svc.getPatient(id);
  if (!p) throw new svc.HttpError(404, "Patient not found.");
  svc.audit(user.name, "patient.view", id, p.name); // every look at a record is logged
  return { ...p, history: db.prepare("SELECT * FROM notes WHERE patient_id = ? ORDER BY id DESC").all(id).map(map.note) };
});

route("POST", "/api/patients/:id/notes", {}, (req, body, user, { id }) => {
  if (!clinicianCanSee(user, id)) throw new svc.HttpError(403, "This patient isn't on your round or in your area.");
  return svc.addNote(id, body.body, user);
});

route("POST", "/api/appointments/:id/status", {}, (req, body, user, { id }) => svc.setStatus(id, body.status, user));

route("POST", "/api/appointments/:id/seen", {}, (req, body, user, { id }) => {
  db.prepare("UPDATE appointments SET seen = 1 WHERE id = ? AND (clinician_id = ? OR ? = 'admin')").run(id, user.clinicianId, user.role);
  return { ok: true };
});

route("GET", "/api/appointments/:id/candidates", {}, (req, body, user, { id }) => {
  needAdmin(user);
  const a = svc.getAppt(id);
  if (!a) throw new svc.HttpError(404, "That visit no longer exists.");
  const { window, candidates } = svc.rank(a, []);
  return { window, candidates };
});

route("POST", "/api/appointments/:id/cancel", {}, (req, body, user, { id }) => {
  const a = svc.getAppt(id);
  if (!a) throw new svc.HttpError(404, "That visit no longer exists.");
  if (user.role === "clinician" && a.clinicianId !== user.clinicianId) throw new svc.HttpError(403, "This visit is on another clinician's round.");
  const reason = D.REASONS.includes(body.reason) ? body.reason : "Patient unwell";
  return svc.cancelAppointment(id, reason, user.name);
});

route("POST", "/api/waitlist", {}, (req, body, user) => { needAdmin(user); return svc.addToWaitlist(body, user); });

route("PUT", "/api/settings", {}, (req, body, user) => {
  needAdmin(user);
  if (body.mode === "offer" || body.mode === "instant") svc.settings.mode = body.mode;
  if (Number(body.offerMinutes) >= 1 && Number(body.offerMinutes) <= 240) svc.settings.offerMinutes = Number(body.offerMinutes);
  svc.audit(user.name, "settings.update", "settings", JSON.stringify(svc.settings));
  bus.emit({ type: "settings.updated", settings: svc.settings });
  return svc.settings;
});

route("POST", "/api/messages/read", {}, (req, body, user) => {
  if (user.clinicianId) db.prepare("UPDATE messages SET read = 1 WHERE to_clinician_id = ?").run(user.clinicianId);
  return { ok: true };
});

// Twilio-compatible inbound webhook. In production: verify the X-Twilio-Signature header before trusting it.
route("POST", "/api/sms/inbound", { public: true }, (req, body) => {
  const from = body.From || body.from;
  const text = body.Body || body.body;
  if (!from || !text) throw new svc.HttpError(400, "Expected From and Body.");
  return svc.handleInbound(from, text);
});

route("POST", "/api/admin/reset", {}, (req, body, user) => {
  needAdmin(user);
  reset();
  svc.settings.mode = "offer";
  bus.emit({ type: "reset" });
  return { ok: true };
});

/* ---------- Debug endpoints for the "Under the hood" page (office only) ---------- */
route("GET", "/api/debug/overview", {}, (req, body, user) => {
  needAdmin(user);
  const counts = Object.fromEntries(TABLES.map((t) => [t, db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n]));
  return {
    counts, requests: reqLog, events: bus.recent.filter((e) => e.type !== "http").slice(0, 40), liveConnections: bus.clients.size,
    audit: db.prepare("SELECT * FROM audit ORDER BY id DESC LIMIT 60").all().map((r) => ({ ...r })),
    outbox: db.prepare("SELECT * FROM messages ORDER BY id DESC LIMIT 40").all().map(map.msg),
    offers: db.prepare("SELECT o.*, p.name AS patient FROM offers o JOIN waitlist w ON w.id = o.waitlist_id JOIN patients p ON p.id = w.patient_id ORDER BY o.id DESC").all().map((r) => ({ ...r })),
    settings: svc.settings, smsProvider: provider, dbFile: path.basename(FILE), node: process.version,
    routes: routes.map((r) => ({ method: r.method, path: r.re.source.slice(1, -1).replace(/\(\[\^\/\]\+\)/g, ":id").replace(/\\\//g, "/"), auth: r.public ? "public" : "signed in" })),
  };
});
route("GET", "/api/debug/table/:name", {}, (req, body, user, { name }) => {
  needAdmin(user);
  if (!TABLES.includes(name)) throw new svc.HttpError(404, "No such table.");
  const cols = db.prepare(`PRAGMA table_info(${name})`).all().map((c) => ({ name: c.name, type: c.type, pk: !!c.pk }));
  return { name, cols, rows: db.prepare(`SELECT * FROM ${name} ORDER BY rowid DESC LIMIT 50`).all().map((r) => ({ ...r })) };
});

/* ---------- Static files ---------- */
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json" };
function serveStatic(req, res) {
  let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (p === "/") p = "/index.html";
  if (p === "/under-the-hood") p = "/under-the-hood.html";
  const file = path.join(PUBLIC, path.normalize(p));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { "Content-Type": "text/plain" }); return res.end("Not found"); }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
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
    const user = verify(url.searchParams.get("token")); // EventSource cannot send headers
    if (!user) return send(res, 401, { error: "Sign in again." });
    // X-Accel-Buffering stops hosting proxies (Render, nginx) holding events back
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.write(`event: hello\ndata: ${JSON.stringify({ user: user.name })}\n\n`);
    const ping = setInterval(() => res.write(": ping\n\n"), 25000);
    res.on("close", () => clearInterval(ping));
    return bus.subscribe(res, user);
  }

  const t0 = process.hrtime.bigint();
  let status = 200;
  let user = null;
  try {
    const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
    if (!r) throw new svc.HttpError(404, "No such endpoint.");
    const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(url.pathname.match(r.re)[i + 1])]));
    user = verify((req.headers.authorization || "").replace(/^Bearer /, ""));
    if (!r.public && !user) throw new svc.HttpError(401, "Sign in again.");
    const body = req.method === "GET" ? {} : await readBody(req);
    const data = await r.handler(req, body, user, params);
    send(res, 200, data);
  } catch (err) {
    status = err.status || 500;
    if (status === 500) console.error(err);
    send(res, status, { error: status === 500 ? "Something went wrong on the server." : err.message });
  } finally {
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    if (!url.pathname.startsWith("/api/debug")) logRequest({ method: req.method, path: url.pathname, status, ms: Math.round(ms * 10) / 10, who: user ? user.name : "anonymous" });
  }
});

setInterval(() => { try { svc.sweepExpired(); } catch (e) { console.error("sweep failed", e); } }, 5000).unref();

server.listen(PORT, () => {
  console.log(`Domi Hearing demo running on http://localhost:${PORT}`);
  console.log(`  Under the hood:  http://localhost:${PORT}/under-the-hood`);
  console.log(`  Database:        ${FILE}`);
  console.log(`  SMS provider:    ${provider}${provider === "outbox" ? " (set TWILIO_* env vars to send real texts)" : ""}`);
});
