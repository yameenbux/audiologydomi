"use strict";
// Staff invitations and sign-in resets. When the office adds someone, or resets a lost phone or a forgotten password,
// that person gets a single-use link. They choose their own password and set up their own authenticator app on it,
// and nobody else ever knows either.
//
//  - The link holds a random token; only a hash of it is stored, so the database can't be used to open a link.
//  - An invitation lasts 7 days, a reset 24 hours. Sending a new link cancels the old one.
//  - A reset stops the old password and authenticator working at once and signs the person out everywhere.
//  - Set-up only finishes once a code from the new app is right, so nobody ends up with an app that doesn't work.
const crypto = require("node:crypto");
const auth = require("./auth");
const sandbox = require("./sandbox");
const notify = require("./notify");
const { db, map } = require("./db");
const svc = require("./service");

const INVITE_MS = 7 * 864e5, RESET_MS = 864e5, MAX_TRIES = 10;
const hash = (t) => crypto.createHash("sha256").update(String(t)).digest("base64url");
const one = (sql, ...a) => db.prepare(sql).get(...a);
const unusable = () => auth.hashPassword(crypto.randomBytes(24).toString("base64url"));
const dateText = (ms) => new Date(ms).toLocaleString("en-GB", { timeZone: "Europe/London", weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/** Where a person's sign-in stands: "ready" (they've set it up), "invited", "reset" (a link is waiting), or "expired". */
function stateOf(userId, now = Date.now()) {
  const last = one("SELECT * FROM invites WHERE user_id = ? AND revoked = 0 ORDER BY created_at DESC, rowid DESC LIMIT 1", userId);
  if (!last || last.used_at) return { state: "ready" };
  return { state: last.expires_at <= now ? "expired" : last.kind === "invite" ? "invited" : "reset", kind: last.kind, sentAt: last.created_at, expiresAt: last.expires_at };
}
/** Has this person ever set up their sign-in? Seeded demo accounts and accounts from live-admin count as set up. */
const everSetUp = (userId) => !one("SELECT 1 FROM invites WHERE user_id = ? AND kind = 'invite'", userId) || !!one("SELECT 1 FROM invites WHERE user_id = ? AND used_at IS NOT NULL", userId);

/**
 * Send someone a link to set up (or set up again) their sign-in. `base` is the address people use (https://…).
 * Returns the link once, so the office can also pass it on by text: it can't be shown again later.
 */
function issue(userId, actor, base, { isNew = false } = {}) {
  return svc.tx(() => {
    const u = one("SELECT * FROM users WHERE id = ?", String(userId));
    if (!u) throw new svc.HttpError(404, "No such account.");
    if (!u.active) throw new svc.HttpError(409, "That account is switched off. Switch it back on first.");
    const sb = sandbox.current(), now = Date.now();
    const kind = !isNew && everSetUp(u.id) ? "reset" : "invite";
    db.prepare("UPDATE invites SET revoked = 1 WHERE user_id = ? AND used_at IS NULL AND revoked = 0").run(u.id);
    if (kind === "reset") {
      // The old password and app stop working now: a lost phone can't be used, even before the new link is opened.
      db.prepare("UPDATE users SET pass_hash = ?, totp_secret = ?, totp_step = -1, failed = 0, locked_until = 0 WHERE id = ?").run(unusable(), auth.newSecret(), u.id);
      for (const s of auth.sessionsFor(sb.id).filter((x) => x.uid === u.id)) auth.endSession(s.id, "sign-in reset by the office");
    }
    const token = crypto.randomBytes(32).toString("base64url");
    const expiresAt = now + (kind === "invite" ? INVITE_MS : RESET_MS);
    db.prepare("INSERT INTO invites (id, user_id, kind, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)").run(hash(token), u.id, kind, actor.name, now, expiresAt);
    const url = `${String(base || "").replace(/\/$/, "")}/invite/${sb.id}/${token}`;
    const practice = sb.settings.practice, first = u.name.split(" ")[0];
    const text = (link) => kind === "invite"
        ? `Hi ${first},\n\n${actor.name} has added you to ${practice} on Domi${u.role === "clinician" ? ", where you'll see your round of home visits" : ""}.\n\nOpen this link to choose your password and set up an authenticator app on your phone. It takes about two minutes:\n\n${link}\n\nThe link works once and expires ${dateText(expiresAt)}. If you weren't expecting this, you can ignore it.\n\n${practice}`
        : `Hi ${first},\n\n${actor.name} has reset your Domi sign-in for ${practice}. Your old password and authenticator codes no longer work.\n\nOpen this link to choose a new password and set up your authenticator app again:\n\n${link}\n\nThe link works once and expires ${dateText(expiresAt)}. If you didn't ask for this, tell the practice office.\n\n${practice}`;
    notify.sendEmail({
      to: u.email, name: u.name, kind: "staff-" + kind,
      subject: kind === "invite" ? `Your Domi sign-in for ${practice}` : `Set up your Domi sign-in again (${practice})`,
      // The stored copy has the link's token blanked: the database (and its backups) can't be used to open it.
      body: text(url), kept: text(url.replace(/[^/]+$/, "••••••")),
    });
    svc.audit(actor.name, kind === "invite" ? "auth.invite" : "auth.reset", u.id, kind === "invite" ? `Sent ${u.name} an invitation to set up their sign-in` : `Reset ${u.name}'s sign-in and sent a link to set it up again`);
    return { kind, url, expiresAt, email: u.email, emailed: notify.emailProvider === "resend" };
  });
}

/** The invitation behind a link, if it can still be used. */
function find(token) {
  const inv = one("SELECT * FROM invites WHERE id = ?", hash(token));
  const gone = new svc.HttpError(410, "This link has expired or has already been used. Ask your practice office to send you a new one.");
  if (!inv || inv.used_at || inv.revoked || inv.expires_at <= Date.now()) throw gone;
  const u = one("SELECT * FROM users WHERE id = ?", inv.user_id);
  if (!u || !u.active) throw gone;
  return { inv, u };
}
function describe(token) {
  const { inv, u } = find(token);
  return { name: u.name, first: u.name.split(" ")[0], email: u.email, role: u.role, title: u.title, kind: inv.kind, expiresAt: inv.expires_at };
}

// Long enough to resist guessing, without rules that push people to write it down: NCSC's "three random words".
const COMMON = /^(password|passw0rd|qwerty|letmein|welcome|iloveyou|admin|domi|optician|monkey|football|sunshine|abc|123)+[0-9!?.]*$/;
function checkNewPassword(pw, u) {
  const p = String(pw || "");
  if (p.length < 12) throw new svc.HttpError(400, "Use at least 12 characters. Three random words works well, like \"kettle-orange-harbour\".");
  if (p.length > 128) throw new svc.HttpError(400, "That's too long: use 128 characters or fewer.");
  const low = p.toLowerCase(), local = u.email.split("@")[0].toLowerCase();
  if (/^(.)\1+$/.test(p) || /^(0123456789|1234567890)+/.test(p) || COMMON.test(low.replace(/[\s_-]/g, ""))) throw new svc.HttpError(400, "That password is too easy to guess. Try three random words.");
  if (local.length >= 4 && low.includes(local)) throw new svc.HttpError(400, "Don't use your email address in your password.");
}

/** Step 1 on the link: the new password. Returns the authenticator set-up (shown once, on this screen). */
function choosePassword(token, password) {
  return svc.tx(() => {
    const { inv, u } = find(token);
    checkNewPassword(password, u);
    const secret = auth.newSecret();
    db.prepare("UPDATE invites SET pass_hash = ?, totp_secret = ?, tries = 0 WHERE id = ?").run(auth.hashPassword(password), secret, inv.id);
    return { secret, otpauth: auth.otpauthUri(secret, u.email) };
  });
}

/** Step 2: a code from the new app. Right, and the account is set up and signed in; wrong too often, and the link stops. */
function confirm(token, code) {
  // A wrong code is counted in its own transaction, so the count survives the error that follows.
  const r = svc.tx(() => {
    const { inv, u } = find(token);
    if (!inv.pass_hash || !inv.totp_secret) throw new svc.HttpError(409, "Choose your password first.");
    const step = auth.matchTotp(inv.totp_secret, code);
    if (step == null) {
      const tries = inv.tries + 1;
      db.prepare("UPDATE invites SET tries = ?, revoked = ? WHERE id = ?").run(tries, tries >= MAX_TRIES ? 1 : 0, inv.id);
      svc.audit(u.name, "auth.failed", u.id, `Wrong code while setting up sign-in (${tries} of ${MAX_TRIES})`);
      return { wrong: tries };
    }
    db.prepare("UPDATE users SET pass_hash = ?, totp_secret = ?, totp_step = ?, failed = 0, locked_until = 0 WHERE id = ?").run(inv.pass_hash, inv.totp_secret, step, u.id);
    db.prepare("UPDATE invites SET used_at = ?, pass_hash = NULL, totp_secret = NULL WHERE id = ?").run(Date.now(), inv.id);
    svc.audit(u.name, "auth.setup", u.id, inv.kind === "invite" ? "Set up their password and authenticator app" : "Set up a new password and authenticator app after a reset");
    return { user: map.user(one("SELECT * FROM users WHERE id = ?", u.id)) };
  });
  if (r.wrong) throw new svc.HttpError(r.wrong >= MAX_TRIES ? 410 : 400, r.wrong >= MAX_TRIES ? "Too many wrong codes, so this link has stopped working. Ask your practice office for a new one." : "That code isn't right. Check the app shows Domi with your email, and type the 6 digits it shows now.");
  return r.user;
}

/** Demo only: the code the new app would show now, so a pitch doesn't need a phone. */
function demoCode(token) {
  const { inv } = find(token);
  if (!inv.totp_secret) throw new svc.HttpError(409, "Choose your password first.");
  return auth.currentCode(inv.totp_secret);
}

module.exports = { issue, stateOf, describe, choosePassword, confirm, demoCode, checkNewPassword, unusable, INVITE_MS, RESET_MS };
