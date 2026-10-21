"use strict";
// Sign-in: password (scrypt) + a six-digit code from an authenticator app (TOTP, RFC 6238), then a
// server-side session held in an HttpOnly cookie. Accounts live in each demo's own database, so every
// visitor's demo is a separate practice with its own codes, lockouts and sessions.
//
// Demo mode (the default; DEMO_MODE=0 turns it off) adds three labelled shortcuts so a pitch flows:
// the password is shown on the sign-in screen, the current code can be filled in for you, and the office
// can pair a phone by QR. None of them exist with DEMO_MODE=0.
const crypto = require("node:crypto");
const { promisify } = require("node:util");
const scrypt = promisify(crypto.scrypt);

// Fails safe: a server with a live database never runs the demo shortcuts (one of them shows the current code),
// even if DEMO_MODE goes missing from its config. Only an explicit DEMO_MODE=1 turns them on there.
const DEMO = process.env.DEMO_MODE === "1" || (process.env.DEMO_MODE !== "0" && !process.env.DATABASE_URL);
const DEMO_PASSWORD = "Leeds-Visits-2026";

/* ---------- Passwords ---------- */
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
function hashPassword(password, salt = crypto.randomBytes(16)) {
  const key = crypto.scryptSync(String(password).normalize("NFKC"), salt, 32, SCRYPT);
  return ["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString("base64url"), key.toString("base64url")].join("$");
}
async function checkPassword(password, stored) {
  const [alg, N, r, p, salt, key] = String(stored || "").split("$");
  if (alg !== "scrypt") return false;
  const want = Buffer.from(key, "base64url");
  const got = await scrypt(String(password).normalize("NFKC"), Buffer.from(salt, "base64url"), want.length, { N: +N, r: +r, p: +p, maxmem: SCRYPT.maxmem });
  return crypto.timingSafeEqual(got, want);
}
// Hashed once at start-up: every demo's accounts share the demo password, each with this hash.
const DEMO_HASH = hashPassword(DEMO_PASSWORD);

/* ---------- Two-factor codes (TOTP) ---------- */
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function base32(buf) {
  let bits = 0, value = 0, out = "";
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  return bits > 0 ? out + B32[(value << (5 - bits)) & 31] : out;
}
function unbase32(str) {
  let bits = 0, value = 0; const out = [];
  for (const ch of String(str).toUpperCase().replace(/=+$/, "")) {
    const i = B32.indexOf(ch); if (i < 0) continue;
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
const STEP = 30, DIGITS = 6, WINDOW = 1; // accept the previous and next 30 seconds for clock drift
function hotp(key, counter, digits = DIGITS) {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac("sha1", key).update(msg).digest();
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 10 ** digits).padStart(digits, "0");
}
const stepAt = (ms = Date.now()) => Math.floor(ms / 1000 / STEP);
const newSecret = () => base32(crypto.randomBytes(20));
/** The step a code matches (within the window, and later than the last one used), or null. */
function matchTotp(secret, code, lastStep = -1, ms = Date.now()) {
  const c = String(code || "").replace(/\D/g, "");
  if (c.length !== DIGITS) return null;
  const key = unbase32(secret), now = stepAt(ms);
  for (let s = now - WINDOW; s <= now + WINDOW; s++) {
    if (s > lastStep && crypto.timingSafeEqual(Buffer.from(hotp(key, s)), Buffer.from(c))) return s;
  }
  return null;
}
/** Demo helper: the code an authenticator app would show now (or the next one, if this one's been used). */
function currentCode(secret, lastStep = -1, ms = Date.now()) {
  const now = stepAt(ms);
  const s = Math.max(now, lastStep + 1);
  if (s > now + WINDOW) return null;
  return { code: hotp(unbase32(secret), s), secondsLeft: (s + 1) * STEP - Math.floor(ms / 1000) };
}
const otpauthUri = (secret, email) => `otpauth://totp/${encodeURIComponent("Domi:" + email)}?secret=${secret}&issuer=${encodeURIComponent("Domi")}&algorithm=SHA1&digits=${DIGITS}&period=${STEP}`;

/* ---------- Short-lived stores (in memory, like the demos themselves) ---------- */
const token = () => crypto.randomBytes(32).toString("base64url");
const IDLE_MS = 2 * 3600e3, ABSOLUTE_MS = 12 * 3600e3;
const CHALLENGE_MS = 5 * 60e3, CHALLENGE_TRIES = 5;
const PAIR_MS = 10 * 60e3;
const LOCK_AFTER = 5, LOCK_MS = 15 * 60e3;

// A session's id is a hash of the token in its cookie: the token itself is never stored, here or in Postgres.
const sessions = new Map();   // id -> { id, sbId, uid, actingAs, kind, created, lastSeen, ua }
const challenges = new Map(); // id -> { sbId, uid, expires, tries }
const pairings = new Map();   // token -> { sbId, uid, by, expires }
const revokeHooks = [];

const keyOf = (t) => crypto.createHash("sha256").update(String(t)).digest("base64url");

// Live practices keep their sessions in Postgres too, so a restart or a deploy doesn't sign everyone out
// (live.js sets the store). Demo sessions stay in memory only.
let store = null;
const TOUCH_SAVE_MS = 5 * 60e3; // how stale lastSeen may get in the store before it's written again
const setSessionStore = (st) => { store = st; };
const save = (s) => { if (store && store.wants(s)) { s.savedSeen = s.lastSeen; store.save(s); } };

/** A new session. Its token goes in the cookie and is never kept; the session is found by the token's hash. */
function createSession({ sbId, uid, kind, ua }) {
  const t = token();
  const s = { id: keyOf(t), sbId, uid, actingAs: null, kind, created: Date.now(), lastSeen: Date.now(), ua: String(ua || "").slice(0, 160) };
  sessions.set(s.id, s);
  save(s);
  return { ...s, token: t };
}
/** The session a cookie's token belongs to, or null if it's missing, idle too long or past its absolute limit. */
const getSession = (t, opts) => (t ? sessionById(keyOf(t), opts) : null);
/** The same, by the session's id. Touching it keeps it alive (and saves lastSeen now and then). */
function sessionById(id, { touch = true } = {}) {
  const s = id && sessions.get(id);
  if (!s) return null;
  const now = Date.now();
  if (now - s.lastSeen > IDLE_MS || now - s.created > ABSOLUTE_MS) { endSession(id, "expired"); return null; }
  if (touch) { s.lastSeen = now; if (now - (s.savedSeen || 0) > TOUCH_SAVE_MS) save(s); }
  return s;
}
function endSession(id, why = "signed out") {
  const s = sessions.get(id);
  if (!s) return false;
  sessions.delete(id);
  if (store && store.wants(s)) store.remove(id);
  revokeHooks.forEach((f) => f(s, why));
  return true;
}
/** Who's viewing as whom changed: keep that across a restart too. */
const sessionChanged = (s) => save(s);
/** Sessions loaded back from the store on start-up, less any that have expired meanwhile. */
function restoreSessions(rows) {
  const now = Date.now();
  let n = 0;
  for (const r of rows) {
    if (now - r.lastSeen > IDLE_MS || now - r.created > ABSOLUTE_MS) { if (store) store.remove(r.id); continue; }
    sessions.set(r.id, { ...r, savedSeen: r.lastSeen });
    n++;
  }
  return n;
}
/** Tests only: forget every session in memory, as a restart would. */
const forgetSessionsForTests = () => sessions.clear();
const sessionsFor = (sbId) => [...sessions.values()].filter((s) => s.sbId === sbId);
const onRevoke = (f) => revokeHooks.push(f);

function newChallenge(sbId, uid) {
  const id = token();
  challenges.set(id, { sbId, uid, expires: Date.now() + CHALLENGE_MS, tries: 0 });
  return id;
}
function getChallenge(id) {
  const c = id && challenges.get(String(id));
  if (!c || Date.now() > c.expires) { challenges.delete(id); return null; }
  return c;
}

function newPairing(sbId, uid, by) {
  const t = token();
  pairings.set(t, { sbId, uid, by, expires: Date.now() + PAIR_MS });
  return t;
}
/** Single use: the link stops working once it has been opened. */
function takePairing(t) {
  const p = t && pairings.get(String(t));
  pairings.delete(String(t));
  return p && Date.now() <= p.expires ? p : null;
}

// Clear out anything expired every minute.
setInterval(() => {
  const now = Date.now();
  for (const [id] of sessions) sessionById(id, { touch: false });
  for (const [id, c] of challenges) if (now > c.expires) challenges.delete(id);
  for (const [t, p] of pairings) if (now > p.expires) pairings.delete(t);
}, 60e3).unref();

/* ---------- Cookies ---------- */
const COOKIE = "domi_session";
function readCookie(req) {
  const m = String(req.headers.cookie || "").match(/(?:^|;\s*)domi_session=([^;]+)/);
  return m ? m[1] : null;
}
function isHttps(req) { return req.socket.encrypted || String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https"; }
function sessionCookie(req, id) {
  return `${COOKIE}=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${ABSOLUTE_MS / 1000}${isHttps(req) ? "; Secure" : ""}`;
}
const clearCookie = (req) => `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${isHttps(req) ? "; Secure" : ""}`;

module.exports = {
  DEMO, DEMO_PASSWORD, DEMO_HASH, LOCK_AFTER, LOCK_MS, CHALLENGE_TRIES, IDLE_MS, ABSOLUTE_MS,
  hashPassword, checkPassword, newSecret, matchTotp, currentCode, otpauthUri, hotp, base32, unbase32, stepAt,
  createSession, getSession, sessionById, endSession, sessionsFor, sessionChanged, setSessionStore, restoreSessions, forgetSessionsForTests, onRevoke, newChallenge, getChallenge, newPairing, takePairing,
  readCookie, sessionCookie, clearCookie,
};
