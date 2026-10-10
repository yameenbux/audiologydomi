"use strict";
// SMS gateway. Without credentials every text goes to the outbox table only (demo mode).
// Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM to send real texts. Nothing else changes.
const { db } = require("./db");

const sid = process.env.TWILIO_ACCOUNT_SID;
const token = process.env.TWILIO_AUTH_TOKEN;
const from = process.env.TWILIO_FROM;
const provider = sid && token && from ? "twilio" : "outbox";

// UK mobile "07700 900123" → E.164 "+447700900123"
const e164 = (phone) => {
  const d = String(phone).replace(/\D/g, "");
  return d.startsWith("44") ? "+" + d : d.startsWith("0") ? "+44" + d.slice(1) : "+" + d;
};

async function deliver(to, body) {
  if (provider !== "twilio") return { providerId: "outbox-" + Date.now().toString(36) };
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
 * Record and send a text. Recording happens first so a provider outage never loses the message;
 * the provider id is filled in once the gateway accepts it.
 */
function sendSms({ to, name, body, kind, toClinicianId = null, fromClinicianId = null }) {
  const row = db.prepare(
    "INSERT INTO messages (direction, to_name, phone, body, kind, to_clinician_id, from_clinician_id) VALUES ('out', ?, ?, ?, ?, ?, ?) RETURNING id"
  ).get(name, to, body, kind, toClinicianId, fromClinicianId);
  deliver(to, body)
    .then(({ providerId }) => db.prepare("UPDATE messages SET provider_id = ? WHERE id = ?").run(providerId, row.id))
    .catch((err) => db.prepare("UPDATE messages SET provider_id = ? WHERE id = ?").run("failed: " + err.message, row.id));
  return row.id;
}

function recordInbound({ phone, name, body }) {
  return db.prepare("INSERT INTO messages (direction, to_name, phone, body, kind) VALUES ('in', ?, ?, ?, 'reply') RETURNING id").get(name, phone, body).id;
}

module.exports = { sendSms, recordInbound, provider, e164 };
