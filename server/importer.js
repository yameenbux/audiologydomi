"use strict";
const sectors = require("./sectors");
// Patient import. Pure functions with no database access: read a CSV (from Google Sheets, Excel or another
// system), work out which column is which, tidy and check every row, and spot people who are already on the
// system. service.js runs it twice: once to show the office a preview, and again when they confirm, so nothing
// is stored between the two steps.

const MAX_BYTES = 3e6;
const MAX_ROWS = 5000;
// Today (the demo's Monday 12 October 2026, or the UK date for a live practice), for ages and recall dates.
const cal = require("./calendar");
const today = () => cal.todayMs();
const DAY_MS = 864e5;

/** The fields a column can map to, in the order the office sees them. */
const FIELDS = [
  { key: "name", label: "Full name" },
  { key: "first", label: "First name" },
  { key: "last", label: "Surname" },
  { key: "dob", label: "Date of birth" },
  { key: "age", label: "Age" },
  { key: "addr", label: "Address line 1" },
  { key: "addr2", label: "Address line 2" },
  { key: "town", label: "Town" },
  { key: "pc", label: "Postcode" },
  { key: "phone", label: "Mobile" },
  { key: "phone2", label: "Other phone" },
  { key: "email", label: "Email" },
  { key: "contact", label: "Contact preference" },
  { key: "eligibility", label: "Reason for a home visit" },
  { key: "rep", label: "Next of kin or carer" },
  { key: "repPhone", label: "Next of kin's phone" },
  { key: "alerts", label: "Access notes" },
  { key: "specs", label: "Glasses" },
  { key: "lastTest", label: "Last sight test" },
  { key: "nextExam", label: "Next exam due" },
  { key: "recallMonths", label: "Recall (months)" },
  { key: "obId", label: "Opticabase ID" },
  { key: "nhsNo", label: "NHS number" },
  { key: "premises", label: "Where they're seen" },
  { key: "notes", label: "Notes" },
];
const FIELD_KEYS = new Set(FIELDS.map((f) => f.key));

// Header names people actually use, squashed to lower-case letters and digits.
const SYNONYMS = {
  name: ["name", "fullname", "patientname", "patient", "clientname", "client", "customer", "customername"],
  first: ["firstname", "forename", "forenames", "givenname", "first", "christianname"],
  last: ["surname", "lastname", "familyname", "last"],
  dob: ["dob", "dateofbirth", "birthdate", "born", "birthday", "dobddmmyyyy"],
  age: ["age", "ageyears"],
  addr: ["address", "address1", "addressline1", "street", "firstlineofaddress", "line1", "houseandstreet", "homeaddress"],
  addr2: ["address2", "addressline2", "line2", "area", "locality", "district"],
  town: ["town", "city", "towncity", "posttown"],
  pc: ["postcode", "postalcode", "pc", "zip", "zipcode"],
  phone: ["mobile", "mobilenumber", "mobileno", "mob", "phone", "telephone", "tel", "phonenumber", "contactnumber", "number", "telno", "cell"],
  phone2: ["landline", "homephone", "home", "otherphone", "phone2", "telephone2", "alternativenumber", "altphone", "homenumber"],
  email: ["email", "emailaddress", "mail"],
  contact: ["contactpreference", "prefers", "preferredcontact", "contactby", "contactmethod", "preference"],
  eligibility: ["domireason", "domreason", "domiciliaryreason", "eligibility", "eligibilityreason", "reason", "homevisitreason", "reasonforhomevisit", "condition", "medicalcondition", "whyhomevisit", "conditions"],
  rep: ["nextofkin", "nok", "carer", "representative", "contactperson", "relative", "familycontact", "emergencycontact", "kin"],
  repPhone: ["nokphone", "nextofkinphone", "nextofkinnumber", "nokno", "noknumber", "carerphone", "carernumber", "relativephone", "emergencycontactnumber", "emergencynumber"],
  alerts: ["access", "accessnotes", "alerts", "keysafe", "warnings", "accessinfo", "accessdetails"],
  specs: ["glasses", "spectacles", "specs", "currentglasses", "lenstype", "lenses"],
  nextExam: ["nextexam", "nextexamdate", "nexttest", "nextsighttest", "nextdue", "recalldate", "duedate", "nexteyetest"],
  recallMonths: ["recall", "recallmonths", "recallperiod", "recallinterval"],
  obId: ["id", "obid", "opticabaseid", "opticabase", "patientid", "pxid", "pxno", "patientno", "patientnumber", "ref", "reference"],
  nhsNo: ["nhsno", "nhsnumber", "nhs", "nhsnum"],
  premises: ["premises", "premisestype", "residence", "residencetype", "accommodation", "livesin"],
  lastTest: ["examdate", "lasttest", "lasteyetest", "lastsighttest", "lastvisit", "lastexam", "dateoflasttest", "lastseen", "lastappointment", "lasttested"],
  notes: ["notes", "comments", "comment", "info", "additionalinfo", "other", "note", "details"],
};
// Looser matches for headers that aren't in the list: a word the header contains.
const CONTAINS = [
  ["repPhone", /(kin|carer|relative|emergency).*(phone|tel|number|no)/], ["rep", /kin|carer|relative|emergency/],
  ["phone2", /landline|home ?phone|alt/], ["phone", /mobile|phone|tel/], ["pc", /post ?code/], ["dob", /birth|dob/],
  ["nextExam", /next.*(exam|test|due)|recall ?date/], ["lastTest", /last.*(test|exam|visit|seen)/], ["eligibility", /eligib|reason|condition/], ["email", /e-?mail/],
  ["nhsNo", /nhs ?(no|num)/], ["first", /first|forename/], ["last", /surname|last ?name/], ["addr", /address/], ["notes", /note|comment/],
];

/** NHS numbers: 10 digits, the last a modulus 11 check digit. */
function validNhs(v) {
  if (!/^\d{10}$/.test(v)) return false;
  const c = 11 - (v.slice(0, 9).split("").reduce((t, d, i) => t + Number(d) * (10 - i), 0) % 11);
  return c !== 10 && (c === 11 ? 0 : c) === Number(v[9]);
}
// PCSE's premises types, by name or initial.
const PREMISES_IN = { home: "home", h: "home", ownhome: "home", residential: "residential", residentialhome: "residential", r: "residential", carehome: "residential", nursing: "nursing", nursinghome: "nursing", n: "nursing", day: "day", daycentre: "day", daycenter: "day", d: "day", sheltered: "sheltered", shelteredhousing: "sheltered", s: "sheltered" };
const squash = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * RFC 4180 CSV: quoted fields, doubled quotes, commas and line breaks inside quotes, CRLF, a byte-order mark.
 * Semicolon- and tab-separated files (Excel in some locales) are recognised from the header line.
 */
function parseCsv(text) {
  let s = String(text || "");
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  const firstLine = s.slice(0, s.search(/\r?\n|$/));
  const count = (ch) => firstLine.split(ch).length - 1;
  const sep = [",", ";", "\t"].sort((a, b) => count(b) - count(a))[0];
  const rows = [];
  let row = [], cell = "", inQ = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQ) {
      if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else inQ = false; }
      else cell += c;
    } else if (c === '"') inQ = true;
    else if (c === sep) { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += c;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows.map((r) => r.map((x) => x.trim())).filter((r) => r.some((x) => x !== ""));
}

/** Best guess at which field each column holds. Each field is used once at most; unknown columns are skipped. */
function guessMapping(headers) {
  const used = new Set();
  const out = headers.map(() => null);
  const take = (i, key) => { if (!used.has(key) && out[i] == null) { out[i] = key; used.add(key); } };
  // A "Mobile" column is the number to text, even when a "Phone" column comes first (Opticabase has both).
  headers.forEach((h, i) => { if (/^(mobile|mobilenumber|mobileno|mob|mobilephone)$/.test(squash(h))) take(i, "phone"); });
  headers.forEach((h, i) => { const k = Object.keys(SYNONYMS).find((f) => SYNONYMS[f].includes(squash(h))); if (k) take(i, k); });
  headers.forEach((h, i) => { if (out[i] == null && /^(phone|telephone|tel|phonenumber)$/.test(squash(h))) take(i, "phone2"); });
  headers.forEach((h, i) => {
    if (out[i] != null) return;
    const low = String(h).toLowerCase();
    const hit = CONTAINS.find(([key, re]) => !used.has(key) && re.test(low));
    if (hit) take(i, hit[0]);
  });
  // A "Name" column next to "Surname" holds first names.
  const nameAt = out.indexOf("name");
  if (nameAt >= 0 && used.has("last") && !used.has("first")) out[nameAt] = "first";
  return out;
}

/* ---------- Tidying values ---------- */
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
/** UK dates as people type them: 03/04/1942, 3-4-42, 1942-04-03, 3 April 1942, 3rd Apr 1942. Day first, never US order. */
function parseDate(v) {
  const s = String(v || "").trim().toLowerCase().replace(/(\d)(st|nd|rd|th)\b/g, "$1");
  if (!s) return null;
  let d, m, y, mt;
  if ((mt = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/))) [, y, m, d] = mt.map(Number);
  else if ((mt = s.match(/^(\d{1,2})[-/. ](\d{1,2})[-/. ](\d{2}|\d{4})$/))) [, d, m, y] = mt.map(Number);
  else if ((mt = s.match(/^(\d{1,2})[\s-]+([a-z]{3,9})[\s,-]+(\d{2}|\d{4})$/))) { d = +mt[1]; m = MONTHS.indexOf(mt[2].slice(0, 3)) + 1; y = +mt[3]; }
  else return null;
  // Two-digit years: these are mostly older patients, so 05 is 2005 only for dates that can't be a birth year.
  if (y < 100) y += y > 26 ? 1900 : 2000;
  const t = Date.UTC(y, m - 1, d);
  const back = new Date(t);
  if (!m || back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) return null;
  return { iso: back.toISOString().slice(0, 10), t };
}
const yearsAt = (t, now = today()) => { const a = new Date(t), b = new Date(now); let n = b.getUTCFullYear() - a.getUTCFullYear(); if (b.getUTCMonth() < a.getUTCMonth() || (b.getUTCMonth() === a.getUTCMonth() && b.getUTCDate() < a.getUTCDate())) n--; return n; };
const fmtDate = (iso) => { const [y, m, d] = iso.split("-").map(Number); return `${d} ${MONTHS[m - 1][0].toUpperCase() + MONTHS[m - 1].slice(1)} ${y}`; };

/** UK numbers to 07700 900112 / 01204 292005. Returns kind "mobile", "landline" or null when it isn't a UK number. */
function parsePhone(v) {
  let d = String(v || "").replace(/[^\d+]/g, "");
  if (!d) return { kind: null, value: "" };
  d = d.replace(/^\+?44/, "0").replace(/^0{2,}/, "0");
  if (/^7\d{9}$/.test(d)) d = "0" + d; // a leading zero lost by a spreadsheet
  if (/^1\d{9}$|^2\d{9}$/.test(d)) d = "0" + d;
  if (/^07\d{9}$/.test(d)) return { kind: "mobile", value: d.replace(/^(\d{5})(\d{6})$/, "$1 $2") };
  if (/^0[123]\d{8,9}$/.test(d)) {
    // Grouped the way the number is dialled: 0161 496 0123 (big cities), 020 7946 0000 (London), 01204 292005.
    const v = /^01\d1/.test(d) ? d.replace(/^(\d{4})(\d{3})(\d+)$/, "$1 $2 $3") : /^0[23]/.test(d) ? d.replace(/^(\d{3})(\d{4})(\d+)$/, "$1 $2 $3") : d.replace(/^(\d{5})(\d+)$/, "$1 $2");
    return { kind: "landline", value: v };
  }
  return { kind: null, value: String(v).trim() };
}

/** "bl1 4ab" → "BL1 4AB". Also says whether it's a whole postcode, just the district, or not a postcode. */
function parsePostcode(v) {
  const s = String(v || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (/^[A-Z]{1,2}\d[A-Z\d]?\d[A-Z]{2}$/.test(s)) return { kind: "full", value: s.slice(0, -3) + " " + s.slice(-3) };
  if (/^[A-Z]{1,2}\d[A-Z\d]?$/.test(s)) return { kind: "district", value: s };
  return { kind: null, value: String(v || "").trim() };
}

const titleCase = (s) => s.toLowerCase().replace(/(^|[\s'-])([a-zà-ÿ])/g, (m, a, b) => a + b.toUpperCase()).replace(/\bMc([a-z])/g, (m, b) => "Mc" + b.toUpperCase());
/** Names typed in capitals or all lower case are tidied; anything already mixed case is left as typed. */
const tidyName = (s) => { const t = String(s || "").replace(/\s+/g, " ").trim(); return t === t.toUpperCase() || t === t.toLowerCase() ? titleCase(t) : t; };

// Words that say someone can't get out, without saying why. Claims guidance asks for the actual condition.
const GENERIC = /^(house ?bound|bed ?bound|immobile|wheelchair( user| bound)?|care home( resident)?|resident|can'?t (get|go) out|unable to leave( home)?|frail|elderly|n\/?a|none|yes|y|-)\.?$/i;

/**
 * Turn one CSV row into a patient, with problems that stop the import (errors) and ones the office should
 * know about (warnings).
 */
function readRow(cells, mapping, { townOf } = {}) {
  const v = {};
  mapping.forEach((key, i) => { if (key && FIELD_KEYS.has(key)) v[key] = v[key] ? `${v[key]} ${cells[i] || ""}`.trim() : (cells[i] || ""); });
  const errors = [], warnings = [];
  const name = tidyName(v.name || [v.first, v.last].filter(Boolean).join(" "));
  if (!name) errors.push("No name");

  const pc = parsePostcode(v.pc);
  if (!v.pc) errors.push("No postcode");
  else if (!pc.kind) errors.push(`"${pc.value}" isn't a UK postcode`);
  else if (pc.kind === "district") warnings.push("Only the first half of the postcode");
  if (pc.kind && townOf && !townOf(pc.value.split(" ")[0])) warnings.push(`${pc.value.split(" ")[0]} is outside the towns you cover`);

  const addr = [v.addr, v.addr2, v.town].map((x) => String(x || "").trim()).filter(Boolean).join(", ");
  if (!addr) warnings.push("No address");

  let dob = null, age = null;
  if (v.dob) {
    const d = parseDate(v.dob);
    if (!d) warnings.push(`Date of birth "${v.dob}" not recognised`);
    else if (d.t > today() || yearsAt(d.t) > 115) warnings.push(`Date of birth ${fmtDate(d.iso)} looks wrong`);
    else { dob = d.iso; age = yearsAt(d.t); }
  }
  if (age == null && v.age !== undefined && v.age !== "") {
    const n = Number(String(v.age).replace(/[^\d.]/g, ""));
    if (Number.isInteger(n) && n > 0 && n < 116) age = n; else warnings.push(`Age "${v.age}" not recognised`);
  }

  // Texts need a mobile. Without one the patient is phoned, never texted.
  const p1 = parsePhone(v.phone), p2 = parsePhone(v.phone2);
  const mobile = [p1, p2].find((p) => p.kind === "mobile");
  const other = [p1, p2].find((p) => p.kind && p !== mobile);
  const phone = mobile ? mobile.value : other ? other.value : "";
  if (!v.phone && !v.phone2) warnings.push("No phone number");
  else if (!mobile && other) warnings.push("Landline only: they'll be phoned, not texted");
  else if (!mobile && !other) warnings.push(`Phone "${v.phone || v.phone2}" not recognised`);
  const pref = squash(v.contact);
  let contact = mobile ? "Text" : "Call";
  if (/call|phone|ring|tel/.test(pref)) contact = "Call";
  else if (/text|sms|message/.test(pref) && !mobile) warnings.push("Prefers texts but has no mobile number");

  const eligibility = String(v.eligibility || "").trim();
  if (!eligibility) warnings.push("No reason recorded for needing a home visit");
  else if (GENERIC.test(eligibility)) warnings.push(`"${eligibility}" alone may not be enough for an NHS claim: record the condition`);

  const email = String(v.email || "").trim();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) warnings.push(`Email "${email}" doesn't look right`);

  const repPhone = parsePhone(v.repPhone);
  const rep = [String(v.rep || "").trim(), repPhone.value].filter(Boolean).join(", ");

  let lastTest = null, recall = null;
  if (v.lastTest) {
    const sec = sectors.current(), last = sec.fields.last;
    const d = parseDate(v.lastTest);
    if (!d) warnings.push(`${last} "${v.lastTest}" not recognised`);
    else if (d.t > today()) warnings.push(`${last} ${fmtDate(d.iso)} is in the future`);
    else {
      lastTest = d.iso;
      // NHS sight tests: yearly from 70, otherwise every two years. Other services recall on their own cycle.
      const months = sec.modules.pcse ? (age != null && age >= 70 ? 12 : 24) : sec.recall.months;
      const due = Date.UTC(new Date(d.t).getUTCFullYear(), new Date(d.t).getUTCMonth() + months, new Date(d.t).getUTCDate());
      const what = sec.recall.what.charAt(0).toUpperCase() + sec.recall.what.slice(1);
      recall = { dueDay: Math.round((due - today()) / DAY_MS),
        reason: sec.modules.pcse ? (months === 12 ? "Yearly NHS sight test (over 70)" : "NHS sight test (every 2 years)") : `${what} (every ${months} month${months === 1 ? "" : "s"})` };
    }
  }

  // From Opticabase: its patient ID (kept to match the two systems), the next exam it worked out, and the recall.
  const obId = String(v.obId || "").trim().replace(/\s+/g, "").slice(0, 20) || null;
  let nextExam = null, recallMonths = null;
  if (v.recallMonths) {
    const n = Number(String(v.recallMonths).replace(/[^\d]/g, ""));
    if ([3, 6, 12, 24].includes(n)) recallMonths = n === 12 ? null : n; else warnings.push(`Recall "${v.recallMonths}" isn't 3, 6, 12 or 24 months`);
  }
  if (v.nextExam) {
    const d = parseDate(v.nextExam);
    if (!d) warnings.push(`Next exam "${v.nextExam}" not recognised`);
    else {
      nextExam = d.iso;
      recall = { dueDay: Math.round((d.t - today()) / DAY_MS), reason: "Next exam due (from Opticabase)" };
    }
  }
  // PCSE's notification and the GOS6 claim need the NHS number: kept only when its check digit is right.
  let nhsNo = null;
  if (v.nhsNo) {
    const n = String(v.nhsNo).replace(/\D/g, "");
    if (validNhs(n)) nhsNo = n; else warnings.push(`NHS number "${v.nhsNo}" isn't valid, so it was left out`);
  }
  let premises = null;
  if (v.premises) {
    const k = squash(v.premises);
    premises = PREMISES_IN[k] || PREMISES_IN[k.slice(0, 1)] || null;
    if (!premises) warnings.push(`"${v.premises}" isn't home, residential home, nursing home, day centre or sheltered housing`);
  }
  const alerts = String(v.alerts || "").split(/[;|\n]+/).map((x) => x.trim()).filter(Boolean).slice(0, 8);
  return {
    errors, warnings, recall,
    patient: {
      name, pc: pc.value, addr: addr || "Address to confirm", phone, contact, dob, age, email: email || null,
      eligibility: eligibility || null, rep: rep || null, alerts, specs: String(v.specs || "").trim() || "None on record",
      lastTest, nextExam, recallMonths, obId, nhsNo, premises, notes: String(v.notes || "").trim().slice(0, 4000) || null,
    },
  };
}

const keyOf = (p) => ({ ob: p.obId ? String(p.obId).toLowerCase() : null, phone: p.phone.replace(/\D/g, ""), namePc: `${p.name.toLowerCase()}|${p.pc.replace(/\s/g, "")}`, nameDob: p.dob ? `${p.name.toLowerCase()}|${p.dob}` : null });

// What a later import can change on a patient already on Domi, matched by their Opticabase ID. Empty cells never
// blank anything: only a value in the file that differs from Domi's counts as a change.
const UPDATABLE = [["name", "name"], ["dob", "date of birth"], ["addr", "address"], ["pc", "postcode"], ["phone", "phone"], ["email", "email"],
  ["eligibility", "reason for a home visit"], ["rep", "next of kin"], ["lastTest", "last sight test"], ["nextExam", "next exam"],
  ["recallMonths", "recall"], ["nhsNo", "NHS number"], ["premises", "where they're seen"]];
const same = (k, a, b) => {
  if (k === "phone") return String(a || "").replace(/\D/g, "") === String(b || "").replace(/\D/g, "");
  return squash(a) === squash(b);
};
/** What's different between a patient on Domi and their row in the file, or why the two can't be the same person. */
function compare(rec, p) {
  if (rec.dob && p.dob && rec.dob !== p.dob) return { conflict: `Opticabase ID ${p.obId} is ${rec.name} on Domi, born ${rec.dob}, but this row says born ${p.dob}` };
  const changes = [];
  for (const [k, label] of UPDATABLE) {
    const v = p[k];
    if (v == null || v === "" || (k === "addr" && v === "Address to confirm") || (k === "recallMonths" && !v)) continue;
    if (!same(k, rec[k], v)) changes.push({ field: k, label, from: rec[k] == null || rec[k] === "" ? null : String(rec[k]), to: String(v) });
  }
  return { changes };
}

/**
 * Check a whole file. `existing` is the patients already on the system, so duplicates are caught before
 * they're created. Rows are returned in file order with a status:
 *  - "ready": new, to be added;
 *  - "update": already on Domi (by Opticabase ID, or found by phone or name and given its ID now), with changes;
 *  - "same": already on Domi, nothing changed;
 *  - "conflict": the Opticabase ID belongs to someone who doesn't match, so nothing is changed;
 *  - "duplicate": already on Domi with no Opticabase ID to match on, or twice in the file;
 *  - "error".
 * Importing the same Opticabase export every morning keeps Domi up to date without double entry.
 */
function check(csv, mappingIn, existing = [], opts = {}) {
  const text = String(csv || "");
  if (!text.trim()) throw new Error("The file is empty.");
  if (Buffer.byteLength(text) > MAX_BYTES) throw new Error("That file is over 3 MB. Split it into smaller files.");
  const table = parseCsv(text);
  if (table.length < 2) throw new Error("The file needs a header row and at least one patient.");
  const [headers, ...data] = table;
  if (data.length > MAX_ROWS) throw new Error(`That file has ${data.length} rows. Import up to ${MAX_ROWS} at a time.`);
  const mapping = Array.isArray(mappingIn) && mappingIn.length === headers.length
    ? mappingIn.map((k) => (FIELD_KEYS.has(k) ? k : null)) : guessMapping(headers);
  const missing = [];
  if (!mapping.some((k) => k === "name" || k === "first" || k === "last")) missing.push("a name");
  if (!mapping.includes("pc")) missing.push("a postcode");

  const seen = { ob: new Map(), phone: new Map(), namePc: new Map(), nameDob: new Map() };
  for (const p of existing) {
    const k = keyOf(p);
    const e = { name: p.name, existing: true, rec: p };
    if (k.ob) seen.ob.set(k.ob, e);
    if (k.phone.length >= 10) seen.phone.set(k.phone, e);
    seen.namePc.set(k.namePc, e);
    if (k.nameDob) seen.nameDob.set(k.nameDob, e);
  }
  const rows = data.map((cells, i) => {
    const r = readRow(cells, mapping, opts);
    const out = { line: i + 2, ...r, status: r.errors.length ? "error" : "ready", duplicateOf: null, patientId: null, changes: [] };
    if (!r.errors.length) {
      const k = keyOf(r.patient);
      const byOb = k.ob && seen.ob.get(k.ob);
      const other = (k.phone.length >= 10 && seen.phone.get(k.phone)) || seen.namePc.get(k.namePc) || (k.nameDob && seen.nameDob.get(k.nameDob));
      // On Domi already: by its Opticabase ID, or found another way and not yet given an ID.
      const known = byOb && byOb.existing ? byOb : !byOb && k.ob && other && other.existing && !other.rec.obId ? other : null;
      if (known) {
        const c = compare(known.rec, r.patient);
        out.patientId = known.rec.id;
        if (c.conflict) { out.status = "conflict"; out.conflict = c.conflict; }
        else {
          if (known !== byOb) c.changes.unshift({ field: "obId", label: "Opticabase ID", from: null, to: r.patient.obId });
          out.changes = c.changes;
          out.status = c.changes.length ? "update" : "same";
          if (c.changes.some((x) => x.field === "name")) out.warnings.push(`Name changes from ${known.rec.name}: check it's the same person`);
        }
      } else if (byOb || other) { const hit = byOb || other; out.status = "duplicate"; out.duplicateOf = hit.existing ? `${hit.name}, already on Domi` : `${hit.name}, row ${hit.line}`; }
      else {
        const me = { name: r.patient.name, line: out.line };
        if (k.ob) seen.ob.set(k.ob, me);
        if (k.phone.length >= 10) seen.phone.set(k.phone, me);
        seen.namePc.set(k.namePc, me);
        if (k.nameDob) seen.nameDob.set(k.nameDob, me);
      }
    }
    return out;
  });
  const count = (s) => rows.filter((r) => r.status === s).length;
  // An example value from each column, so the office can see what a column holds when choosing its field.
  const samples = headers.map((_, i) => { const r = data.find((x) => x[i]); return r ? r[i].slice(0, 60) : ""; });
  return {
    headers, mapping, missing, rows, samples,
    counts: { total: rows.length, ready: count("ready"), update: count("update"), same: count("same"), conflict: count("conflict"), duplicate: count("duplicate"), error: count("error"), warnings: rows.filter((r) => (r.status === "ready" || r.status === "update") && r.warnings.length).length },
  };
}

module.exports = { FIELDS, MAX_ROWS, parseCsv, guessMapping, parseDate, parsePhone, parsePostcode, readRow, check };
