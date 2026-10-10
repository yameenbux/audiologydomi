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

const DEMO = process.env.DEMO_MODE !== "0";
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
const otpauthUri = (secret, email) => `otpauth://totp/${encodeURIComponent("Domi Hearing:" + email)}?secret=${secret}&issuer=${encodeURIComponent("Domi Hearing")}&algorithm=SHA1&digits=${DIGITS}&period=${STEP}`;

/* ---------- Short-lived stores (in memory, like the demos themselves) ---------- */
const token = () => crypto.randomBytes(32).toString("base64url");
const IDLE_MS = 2 * 3600e3, ABSOLUTE_MS = 12 * 3600e3;
const CHALLENGE_MS = 5 * 60e3, CHALLENGE_TRIES = 5;
const PAIR_MS = 10 * 60e3;
const LOCK_AFTER = 5, LOCK_MS = 15 * 60e3;

const sessions = new Map();   // id -> { id, sbId, uid, actingAs, kind, created, lastSeen, ua }
const challenges = new Map(); // id -> { sbId, uid, expires, tries }
const pairings = new Map();   // token -> { sbId, uid, by, expires }
const revokeHooks = [];

function createSession({ sbId, uid, kind, ua }) {
  const s = { id: token(), sbId, uid, actingAs: null, kind, created: Date.now(), lastSeen: Date.now(), ua: String(ua || "").slice(0, 160) };
  sessions.set(s.id, s);
  return s;
}
/** A live session, or null if it's missing, idle too long or past its absolute limit. Touches lastSeen. */
function getSession(id, { touch = true } = {}) {
  const s = id && sessions.get(id);
  if (!s) return null;
  const now = Date.now();
  if (now - s.lastSeen > IDLE_MS || now - s.created > ABSOLUTE_MS) { endSession(id, "expired"); return null; }
  if (touch) s.lastSeen = now;
  return s;
}
function endSession(id, why = "signed out") {
  const s = sessions.get(id);
  if (!s) return false;
  sessions.delete(id);
  revokeHooks.forEach((f) => f(s, why));
  return true;
}
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
  for (const [id] of sessions) getSession(id, { touch: false });
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
  createSession, getSession, endSession, sessionsFor, onRevoke, newChallenge, getChallenge, newPairing, takePairing,
  readCookie, sessionCookie, clearCookie,
};
