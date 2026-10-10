"use strict";
// SMS gateway. Without credentials every text is stored in the sandbox's outbox only (demo mode).
// Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM to send real texts. Nothing else changes.
const crypto = require("node:crypto");
const { db } = require("./db");
const sandbox = require("./sandbox");

const sid = process.env.TWILIO_ACCOUNT_SID;
const token = process.env.TWILIO_AUTH_TOKEN;
const from = process.env.TWILIO_FROM;
const provider = sid && token && from ? "twilio" : "outbox";
const publicUrl = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || "").replace(/\/$/, "");

// UK mobile "07700 900123" → E.164 "+447700900123"
const e164 = (phone) => {
  const d = String(phone).replace(/\D/g, "");
  return d.startsWith("44") ? "+" + d : d.startsWith("0") ? "+44" + d.slice(1) : "+" + d;
};

async function deliver(to, body) {
  if (provider !== "twilio" || to === "clinician") return { providerId: "outbox-" + crypto.randomUUID().slice(0, 8) };
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: { Authorization: "Basic " + Buffer.from(`${sid}:${token}`).toString("base64"), "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ To: e164(to), From: from, Body: body }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.message || `Twilio returned ${res.status}`);
  return { providerId: json.sid };
}

/**
 * Record a text now; send it once the surrounding transaction commits (see service.tx).
 * A booking that rolls back therefore never sends a text.
 */
function sendSms({ to, name, body, kind, toClinicianId = null, fromClinicianId = null }) {
  const row = db.prepare(
    "INSERT INTO messages (direction, to_name, phone, body, kind, to_clinician_id, from_clinician_id, created_at) VALUES ('out', ?, ?, ?, ?, ?, ?, ?) RETURNING id"
  ).get(name, to, body, kind, toClinicianId, fromClinicianId, sandbox.stamp());
  const sb = sandbox.current();
  // The sandbox may be reset or evicted before the provider answers, so the follow-up write is best-effort.
  const note = (providerId) => { try { sandbox.run(sb, () => db.prepare("UPDATE messages SET provider_id = ? WHERE id = ?").run(providerId, row.id)); } catch {} };
  const job = () => deliver(to, body).then(({ providerId }) => note(providerId), (err) => note("failed: " + err.message));
  if (sb.pending) sb.pending.sends.push(job); else job();
  return row.id;
}

function recordInbound({ phone, name, body }) {
  return db.prepare("INSERT INTO messages (direction, to_name, phone, body, kind, created_at) VALUES ('in', ?, ?, ?, 'reply', ?) RETURNING id").get(name, phone, body, sandbox.stamp()).id;
}

/** Twilio signs every webhook: HMAC-SHA1 of the full URL plus the sorted POST params. Reject anything else. */
function verifyTwilio(signature, path, params) {
  if (provider !== "twilio" || !publicUrl || !signature) return false;
  const data = publicUrl + path + Object.keys(params).sort().map((k) => k + params[k]).join("");
  const expected = crypto.createHmac("sha1", token).update(Buffer.from(data, "utf-8")).digest("base64");
  return expected.length === signature.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

module.exports = { sendSms, recordInbound, verifyTwilio, provider, e164 };
