"use strict";
// Leads from the practice's ads: someone filled in the form on a Facebook ad (or any ad form) asking to be called.
// They arrive here from a connector (Zapier, Make, or Meta's own webhook), get a thank-you email straight away
// with the office hours, and wait in the office's Leads list until someone phones them. Not a patient record:
// the office turns a lead into a referral or booking once they've spoken.
const crypto = require("node:crypto");
const { db, map, leadEmail } = require("./db");
const sandbox = require("./sandbox");
const bus = require("./bus");
const { sendEmail } = require("./notify");
const { tx, audit, HttpError, settings } = require("./service");

const STATUS = { new: "New", contacted: "Contacted", booked: "Visit booked", closed: "Not interested" };
const clean = (v, max) => String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
const digits = (v) => String(v || "").replace(/\D/g, "").replace(/^44/, "0");
const phoneOf = (v) => { const d = digits(v); return /^0\d{9,10}$/.test(d) ? d.replace(/^(\d{5})(\d+)$/, "$1 $2") : null; };
const emailOf = (v) => { const e = clean(v, 120).toLowerCase(); return /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(e) ? e : null; };

/**
 * A date of birth as an ad form sends it: 1942-04-03, or 03/04/1942. Meta's forms can send US order (month first),
 * so a date that only makes sense one way is read that way; one that fits both is read the UK way. ISO, or null.
 */
function dobOf(v) {
  const t = String(v || "").trim();
  let y, m, d, x;
  if ((x = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) [y, m, d] = [+x[1], +x[2], +x[3]];
  else if ((x = t.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/))) { const a = +x[1], b = +x[2]; y = +x[3]; [d, m] = b > 12 && a <= 12 ? [b, a] : [a, b]; }
  else return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1 || y < 1900 || dt.getTime() > Date.now()) return null;
  return dt.toISOString().slice(0, 10);
}

// The field names a form may use for the details we file separately. Everything else is kept as a question and answer.
const KEYS = { name: ["full_name", "name", "fullname"], first: ["first_name"], last: ["last_name"], phone: ["phone_number", "phone", "mobile"], email: ["email", "email_address"], pc: ["post_code", "postcode", "zip_code", "zip", "pc"],
  addr: ["street_address", "address", "street", "address_line_1", "full_address"], city: ["city", "town"], dob: ["date_of_birth", "dob", "birthday", "birth_date"] };
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
  const addr = clean([pick(KEYS.addr), pick(KEYS.city)].filter(Boolean).join(", "), 160) || null;
  // No postcode question on the form (Home Visiting Optics' asks for a street address): find one in the address.
  let pc = clean(pick(KEYS.pc), 10).toUpperCase() || null, pcFrom = pc ? "form" : null;
  if (!pc && addr) { const m = addr.toUpperCase().match(/\b([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})\b/); if (m) { pc = `${m[1]} ${m[2]}`; pcFrom = "address"; } }
  return { name, phone: phoneOf(pick(KEYS.phone)), email: emailOf(pick(KEYS.email)), pc, pcFrom, addr, dob: dobOf(pick(KEYS.dob)),
    campaign: clean(pick(["ad_name", "campaign_name", "campaign", "form_name"]), 80) || null, answers };
}

const thanksSubject = () => `Thank you for getting in touch with ${settings().practice}`;
const contact = () => sandbox.brandView();
const thanksBody = (name) => leadEmail(name, settings().practice, contact().phone, settings().officeHours, contact().email);

/** A new lead: saved, matched to an existing patient by phone or email, and thanked by email. */
function receive(input, { via = "test form" } = {}) {
  const l = normalise(input || {});
  if (l.name.length < 2) throw new HttpError(400, "A lead needs a name.");
  if (!l.phone && !l.email) throw new HttpError(400, "A lead needs a phone number or an email address.");
  return tx(() => {
    const id = "ld" + Math.random().toString(36).slice(2, 10);
    const match = db.prepare("SELECT id, phone, email FROM patients WHERE erased = 0").all()
      .find((p) => (l.phone && digits(p.phone) === digits(l.phone)) || (l.email && p.email && p.email.toLowerCase() === l.email));
    db.prepare("INSERT INTO leads (id, created_at, created_min, source, campaign, name, phone, email, pc, answers, patient_id, addr, dob, pc_from) VALUES (?, ?, ?, 'facebook', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, sandbox.stamp().slice(0, 5), sandbox.nowMin(), l.campaign, l.name, l.phone, l.email, l.pc, JSON.stringify(l.answers), match ? match.id : null, l.addr, l.dob, l.pcFrom);
    const mail = l.email ? { subject: thanksSubject(), body: thanksBody(l.name) } : null;
    if (mail) sendEmail({ to: l.email, name: l.name, ...mail, kind: "lead.thanks", leadId: id, replyTo: contact().email }); // replies go to the practice
    audit("Ad form", "lead.received", id, l.campaign ? `From the ad "${l.campaign}"` : "From an ad form"); // no personal details in the audit line
    bus.emit({ type: "lead.updated", leadId: id, fresh: true });
    const link = settings().leadLink;
    Object.assign(link, { lastAt: sandbox.stamp().slice(0, 5), lastVia: via, count: link.count + 1, error: null, errorAt: null });
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


/* ---------- Connecting the practice's Facebook ---------- */
/** Compares secrets in constant time, so the time taken gives nothing away. */
function sameSecret(a, b) {
  const x = Buffer.from(String(a || "")), y = Buffer.from(String(b || ""));
  return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
}
const note = (error) => Object.assign(settings().leadLink, { error, errorAt: sandbox.stamp().slice(0, 5) });
const GRAPH = () => process.env.META_GRAPH_URL || "https://graph.facebook.com/v21.0";

/**
 * A notice from Facebook's own webhook. Meta signs the body with the app secret (X-Hub-Signature-256), so
 * anything unsigned or signed with another secret is refused. Each notice only names the lead, so Domi then
 * fetches it from Facebook with the page's access token. Meta needs a quick answer, so fetching happens after.
 */
function metaNotice(raw, signature, body) {
  const m = settings().meta;
  if (!m.appSecret || !m.pageToken || !m.pageId) throw new HttpError(409, "Facebook isn't connected for this practice yet.");
  const expected = "sha256=" + crypto.createHmac("sha256", m.appSecret).update(raw, "utf8").digest("hex");
  if (!sameSecret(signature, expected)) { note("A notice arrived that wasn't signed with your app secret, so it was ignored."); throw new HttpError(403, "Signature doesn't match."); }
  const ids = (Array.isArray(body.entry) ? body.entry : []).flatMap((e) => (Array.isArray(e.changes) ? e.changes : [])
    .filter((c) => c.field === "leadgen" && c.value && String(c.value.page_id) === m.pageId).map((c) => String(c.value.leadgen_id || "")))
    .filter((id) => /^\d{1,30}$/.test(id)).slice(0, 20);
  const sb = sandbox.current();
  for (const id of ids) setImmediate(() => sandbox.run(sb, () => fetchLead(id, m.pageToken).catch((e) => note(e.message))));
  return { ok: true, leads: ids.length };
}
async function fetchLead(id, token) {
  const url = `${GRAPH()}/${id}?fields=field_data,ad_name,campaign_name,form_id&access_token=${encodeURIComponent(token)}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(10000) }).catch(() => null);
  if (!r) throw new Error("Couldn't reach Facebook to fetch a new lead. It will need adding by hand.");
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Facebook wouldn't hand over a new lead${d.error && d.error.message ? `: ${String(d.error.message).slice(0, 160)}` : ""}. Check the page access token.`);
  if (db.prepare("SELECT 1 FROM leads WHERE meta_id = ?").get(id)) return; // Facebook can send the same notice twice
  const res = receive({ field_data: d.field_data || [], ad_name: d.ad_name, campaign_name: d.campaign_name }, { via: "Facebook" });
  db.prepare("UPDATE leads SET meta_id = ? WHERE id = ?").run(id, res.id);
}

/** What the office needs to connect: their private link and key, Facebook's settings, and the latest activity. */
function connection(base) {
  const sb = sandbox.current(), st = sb.settings, m = st.meta;
  return {
    hookUrl: `${base}/api/hooks/${sb.id}/leads?key=${st.leadsKey}`, key: st.leadsKey,
    meta: { callbackUrl: `${base}/api/hooks/${sb.id}/meta`, verifyToken: m.verifyToken, pageId: m.pageId,
      hasSecret: !!m.appSecret, hasToken: !!m.pageToken, tokenEnd: m.pageToken ? m.pageToken.slice(-4) : null, connected: !!(m.pageId && m.appSecret && m.pageToken) },
    status: st.leadLink, testForm: `${base}/ad-form/${sb.id}`,
  };
}
/** A new key: the old link stops working at once, for example if it was shared by mistake. */
function newKey(user, base) {
  settings().leadsKey = crypto.randomBytes(18).toString("base64url");
  audit(user.name, "leads.key", "settings", "New connector key; the old link no longer works");
  return connection(base);
}
/** Facebook's details. A secret left blank keeps the one already saved; secrets are never sent back. */
function saveMeta(input, user, base) {
  const m = settings().meta, changed = [];
  if (input.pageId !== undefined) { const v = String(input.pageId || "").trim(); if (v && !/^\d{5,30}$/.test(v)) throw new HttpError(400, "The Page ID is the number in your Facebook Page's About section."); if (v !== m.pageId) { m.pageId = v; changed.push("Page ID"); } }
  if (input.appSecret) { const v = String(input.appSecret).trim(); if (!/^[a-f0-9]{32}$/i.test(v)) throw new HttpError(400, "The app secret is 32 letters and numbers, from your Meta app's Basic settings."); m.appSecret = v; changed.push("app secret"); }
  if (input.pageToken) { const v = String(input.pageToken).trim(); if (!/^[A-Za-z0-9_-]{40,600}$/.test(v)) throw new HttpError(400, "That doesn't look like a page access token. Copy it again from Meta."); m.pageToken = v; changed.push("page access token"); }
  if (input.disconnect === true) { Object.assign(m, { appSecret: "", pageToken: "" }); changed.push("disconnected"); }
  if (changed.length) audit(user.name, "leads.meta", "settings", `Facebook connection: ${changed.join(", ")}`); // never the values
  return { ...connection(base), changed };
}

module.exports = { dobOf, sameSecret, metaNotice, connection, newKey, saveMeta, receive, setLeadStatus, leadList, leadEmails, preview, normalise, STATUS };
