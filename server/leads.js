"use strict";
// Leads from the practice's ads: someone filled in the form on a Facebook ad (or any ad form) asking to be called.
// They arrive here from a connector (Zapier, Make, or Meta's own webhook), get a thank-you email straight away
// with the office hours, and wait in the office's Leads list until someone phones them. Not a patient record:
// the office turns a lead into a referral or booking once they've spoken.
const { db, map, leadEmail } = require("./db");
const sandbox = require("./sandbox");
const bus = require("./bus");
const { sendEmail } = require("./notify");
const { tx, audit, HttpError, settings } = require("./service");
const brands = require("./brands");

const STATUS = { new: "New", contacted: "Contacted", booked: "Visit booked", closed: "Not interested" };
const clean = (v, max) => String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
const digits = (v) => String(v || "").replace(/\D/g, "").replace(/^44/, "0");
const phoneOf = (v) => { const d = digits(v); return /^0\d{9,10}$/.test(d) ? d.replace(/^(\d{5})(\d+)$/, "$1 $2") : null; };
const emailOf = (v) => { const e = clean(v, 120).toLowerCase(); return /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(e) ? e : null; };

// The field names a form may use for the details we file separately. Everything else is kept as a question and answer.
const KEYS = { name: ["full_name", "name", "fullname"], first: ["first_name"], last: ["last_name"], phone: ["phone_number", "phone", "mobile"], email: ["email", "email_address"], pc: ["post_code", "postcode", "zip_code", "zip", "pc"] };
const META_KEYS = ["campaign_name", "campaign", "ad_name", "adset_name", "form_name", "form_id", "ad_id", "leadgen_id", "page_id", "created_time", "platform", "is_organic", "formMs", "website", "test"];
const label = (k) => { const s = String(k).replace(/[_?]+/g, " ").trim(); return s.charAt(0).toUpperCase() + s.slice(1) + (/^(who|when|what|how|which|why|do|does|is|are|can)\b/i.test(s) ? "?" : ""); };

/**
 * Turns what a connector sends into one lead. Accepts a flat object of form answers (what Zapier and Make send),
 * or Meta's lead format with field_data: [{ name, values: [...] }].
 */
function normalise(input) {
  const fields = {};
  if (Array.isArray(input.field_data)) for (const f of input.field_data) fields[String(f.name || "").toLowerCase()] = Array.isArray(f.values) ? f.values.join(", ") : f.values;
  for (const [k, v] of Object.entries(input)) if (k !== "field_data" && (typeof v === "string" || typeof v === "number")) fields[k.toLowerCase()] = String(v);
  const pick = (names) => { for (const n of names) if (fields[n] != null && String(fields[n]).trim()) return String(fields[n]); return ""; };
  const used = new Set([...Object.values(KEYS).flat(), ...META_KEYS.map((k) => k.toLowerCase())]);
  const answers = Object.entries(fields).filter(([k]) => !used.has(k)).slice(0, 12).map(([k, v]) => [clean(label(k), 80), clean(v, 300)]).filter(([, v]) => v);
  const name = clean(pick(KEYS.name) || [pick(KEYS.first), pick(KEYS.last)].filter(Boolean).join(" "), 80);
  return { name, phone: phoneOf(pick(KEYS.phone)), email: emailOf(pick(KEYS.email)), pc: clean(pick(KEYS.pc), 10).toUpperCase() || null,
    campaign: clean(pick(["ad_name", "campaign_name", "campaign", "form_name"]), 80) || null, answers };
}

const thanksSubject = () => `Thank you for getting in touch with ${settings().practice}`;
const thanksBody = (name) => leadEmail(name, settings().practice, brands.pub(sandbox.current().brand).phone, settings().officeHours);

/** A new lead: saved, matched to an existing patient by phone or email, and thanked by email. */
function receive(input) {
  const l = normalise(input || {});
  if (l.name.length < 2) throw new HttpError(400, "A lead needs a name.");
  if (!l.phone && !l.email) throw new HttpError(400, "A lead needs a phone number or an email address.");
  return tx(() => {
    const id = "ld" + Math.random().toString(36).slice(2, 10);
    const match = db.prepare("SELECT id, phone, email FROM patients WHERE erased = 0").all()
      .find((p) => (l.phone && digits(p.phone) === digits(l.phone)) || (l.email && p.email && p.email.toLowerCase() === l.email));
    db.prepare("INSERT INTO leads (id, created_at, created_min, source, campaign, name, phone, email, pc, answers, patient_id) VALUES (?, ?, ?, 'facebook', ?, ?, ?, ?, ?, ?, ?)")
      .run(id, sandbox.stamp().slice(0, 5), sandbox.nowMin(), l.campaign, l.name, l.phone, l.email, l.pc, JSON.stringify(l.answers), match ? match.id : null);
    const mail = l.email ? { subject: thanksSubject(), body: thanksBody(l.name) } : null;
    if (mail) sendEmail({ to: l.email, name: l.name, ...mail, kind: "lead.thanks", leadId: id });
    audit("Ad form", "lead.received", id, l.campaign ? `From the ad "${l.campaign}"` : "From an ad form"); // no personal details in the audit line
    bus.emit({ type: "lead.updated", leadId: id, fresh: true });
    return { ok: true, id, emailed: !!mail, email: mail }; // the email is the sender's own, so the test ad form can show it
  });
}

/** The office marks what happened when they called: contacted, visit booked, or not interested, with a note. */
function setLeadStatus(id, input, user) {
  return tx(() => {
    const r = db.prepare("SELECT * FROM leads WHERE id = ?").get(String(id));
    if (!r) throw new HttpError(404, "That lead no longer exists.");
    const status = input.status in STATUS ? input.status : r.status;
    const note = input.note === undefined ? r.note : clean(input.note, 500) || null;
    db.prepare("UPDATE leads SET status = ?, note = ?, handled_by = ?, handled_at = ? WHERE id = ?").run(status, note, user.name, sandbox.stamp().slice(0, 5), r.id);
    audit(user.name, "lead.status", r.id, STATUS[status]);
    bus.emit({ type: "lead.updated", leadId: r.id });
    return map.lead(db.prepare("SELECT * FROM leads WHERE id = ?").get(r.id));
  });
}

const leadList = () => db.prepare("SELECT * FROM leads ORDER BY status = 'new' DESC, created_min DESC").all().map(map.lead);
const leadEmails = () => db.prepare("SELECT * FROM emails WHERE kind = 'lead.thanks' ORDER BY id DESC").all().map(map.email);
/** What the next thank-you email will say, for the office to check. */
const preview = () => ({ subject: thanksSubject(), body: thanksBody("Joan Whittle") });

module.exports = { receive, setLeadStatus, leadList, leadEmails, preview, normalise, STATUS };
