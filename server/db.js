"use strict";
// SQLite storage via Node's built-in driver. One file, no install. Swap for Postgres in production.
const { DatabaseSync } = require("node:sqlite");
const path = require("node:path");
const fs = require("node:fs");

const FILE = process.env.DB_FILE || path.join(__dirname, "..", "data", "domi.sqlite");
fs.mkdirSync(path.dirname(FILE), { recursive: true });
const db = new DatabaseSync(FILE);
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS clinicians (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, first TEXT NOT NULL, role TEXT NOT NULL, color TEXT NOT NULL,
  area_name TEXT NOT NULL, patch TEXT NOT NULL, near TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('admin','clinician')),
  clinician_id TEXT REFERENCES clinicians(id)
);
CREATE TABLE IF NOT EXISTS patients (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, age INTEGER, addr TEXT NOT NULL, pc TEXT NOT NULL, phone TEXT NOT NULL,
  contact TEXT NOT NULL DEFAULT 'Text', alerts TEXT NOT NULL DEFAULT '[]', aids TEXT NOT NULL DEFAULT 'None yet', audio TEXT
);
CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT, patient_id TEXT NOT NULL REFERENCES patients(id), label TEXT NOT NULL,
  body TEXT NOT NULL, author TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS appointments (
  id TEXT PRIMARY KEY, clinician_id TEXT NOT NULL REFERENCES clinicians(id), patient_id TEXT NOT NULL REFERENCES patients(id),
  type TEXT NOT NULL, start_min INTEGER NOT NULL, drive INTEGER NOT NULL DEFAULT 10,
  status TEXT NOT NULL CHECK (status IN ('booked','enroute','live','done','cancelled')),
  moved INTEGER NOT NULL DEFAULT 0, seen INTEGER NOT NULL DEFAULT 0, note TEXT, reason TEXT, gap INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS waitlist (
  id TEXT PRIMARY KEY, patient_id TEXT NOT NULL REFERENCES patients(id), type TEXT NOT NULL, prio TEXT NOT NULL,
  days INTEGER NOT NULL DEFAULT 0, avail TEXT NOT NULL DEFAULT 'any', short_notice INTEGER NOT NULL DEFAULT 1,
  pref_clinician_id TEXT, status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','offered','booked')),
  added_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS offers (
  id INTEGER PRIMARY KEY AUTOINCREMENT, slot_id TEXT NOT NULL REFERENCES appointments(id), waitlist_id TEXT NOT NULL REFERENCES waitlist(id),
  status TEXT NOT NULL CHECK (status IN ('pending','accepted','declined','expired','superseded')),
  score INTEGER, sent_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, booked_appointment_id TEXT
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, direction TEXT NOT NULL CHECK (direction IN ('out','in')),
  to_name TEXT, phone TEXT, body TEXT NOT NULL, kind TEXT NOT NULL, to_clinician_id TEXT, from_clinician_id TEXT,
  provider_id TEXT, read INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL DEFAULT (datetime('now')), actor TEXT NOT NULL,
  action TEXT NOT NULL, entity TEXT, detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_appt_clin ON appointments(clinician_id, start_min);
CREATE INDEX IF NOT EXISTS idx_offer_pending ON offers(status, expires_at);
`;

const TABLES = ["audit", "messages", "offers", "notes", "appointments", "waitlist", "users", "patients", "clinicians"];

function reset() {
  db.exec("PRAGMA foreign_keys = OFF;");
  for (const t of TABLES) db.exec(`DROP TABLE IF EXISTS ${t};`);
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  seed();
}

function seed() {
  const ins = (table, row) => {
    const keys = Object.keys(row);
    db.prepare(`INSERT INTO ${table} (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`)
      .run(...keys.map((k) => (row[k] !== null && typeof row[k] === "object" ? JSON.stringify(row[k]) : row[k])));
  };
  db.exec("BEGIN");
  [
    { id: "c1", name: "Amira Shah", first: "Amira", role: "Audiologist", color: "#2D3F7A", area_name: "North Leeds", patch: ["LS6", "LS16", "LS17"], near: ["LS7", "LS18", "LS8"] },
    { id: "c2", name: "Tom Whitfield", first: "Tom", role: "Hearing aid dispenser", color: "#2F7A6A", area_name: "East Leeds", patch: ["LS8", "LS9", "LS15"], near: ["LS7", "LS14", "LS26"] },
    { id: "c3", name: "Priya Nair", first: "Priya", role: "Audiologist", color: "#8A4E7A", area_name: "South & West", patch: ["LS11", "LS12", "LS27"], near: ["LS13", "LS10", "LS28"] },
  ].forEach((r) => ins("clinicians", r));
  [
    { id: "u-admin", name: "Sarah Lane", role: "admin", clinician_id: null },
    { id: "u-c1", name: "Amira Shah", role: "clinician", clinician_id: "c1" },
    { id: "u-c2", name: "Tom Whitfield", role: "clinician", clinician_id: "c2" },
    { id: "u-c3", name: "Priya Nair", role: "clinician", clinician_id: "c3" },
  ].forEach((r) => ins("users", r));

  const P = (id, name, age, addr, pc, phone, o = {}) => ({ id, name, age, addr, pc, phone, contact: o.contact || "Text", alerts: o.alerts || [], aids: o.aids || "None yet", audio: o.audio || null, _h: o.h || [] });
  const patients = [
    P("p1", "Dorothy Fenwick", 84, "12 Weetwood Lane", "LS16", "07700 900112", { alerts: ["Daughter Julie present for visits"], aids: "RIC aids, both ears (fitted 2024)", audio: { R: [30, 35, 45, 55, 65, 75], L: [25, 35, 40, 55, 70, 80] }, h: [["14 Mar 2026", "Annual review. Domes replaced, aids cleaned. Reports TV clearer."]] }),
    P("p2", "Peter Dunn", 79, "3 Otley Road, Headingley", "LS6", "07700 900245", { contact: "Call", aids: "BTE aid, left ear", audio: { R: [20, 25, 30, 45, 60, 70], L: [40, 45, 55, 65, 75, 85] }, h: [["2 Sep 2026", "Assessment. Moderate-severe loss left. Fitting booked."]] }),
    P("p3", "Hilda Marsh", 91, "Flat 4, Moor Court", "LS17", "07700 900318", { alerts: ["Care home: sign in at reception", "Uses wheelchair"], aids: "RIC aids, both ears", audio: { R: [45, 50, 55, 65, 75, 85], L: [45, 50, 60, 70, 80, 90] }, h: [["20 Jul 2026", "Wax removed both ears. Aids retubed."]] }),
    P("p4", "Ken Ollerton", 72, "28 Spen Lane", "LS16", "07700 900427", { h: [["Referral", "GP referral: gradual loss, struggles in groups."]] }),
    P("p5", "Margaret Holt", 81, "14 Ash Grove", "LS6", "07700 900533", { alerts: ["Hard of hearing: text, don't call"], aids: "Old BTE aids, both ears (2017)", audio: { R: [35, 40, 50, 60, 70, 80], L: [35, 45, 50, 60, 70, 75] }, h: [["28 Aug 2026", "Assessment. New aids ordered, awaiting fitting."]] }),
    P("p6", "Arthur Pell", 88, "7 Easterly Road", "LS8", "07700 900641", { aids: "RIC aid, right ear", h: [["1 May 2026", "Fitting. Good benefit reported."]] }),
    P("p7", "June Akroyd", 76, "51 Selby Road", "LS15", "07700 900752", { h: [["Referral", "Self-referral. Tinnitus left ear."]] }),
    P("p8", "Stanley Rhodes", 83, "2 Kirkstall Hill", "LS6", "07700 900863", { alerts: ["Wife Brenda answers door"], aids: "BTE aids, both ears", h: [["10 Jun 2026", "Wax impacted right. Microsuction booked."]] }),
    P("p9", "Irene Battye", 90, "9 Moor Allerton Drive", "LS17", "07700 900974", { alerts: ["Carer visits 10:00–10:30"], h: [["Referral", "Daughter reports aids whistling."]] }),
    P("p10", "Brian Clegg", 69, "33 Tong Road", "LS12", "07700 900185", { aids: "RIC aids, both ears", h: [["5 Aug 2026", "Fitting. Fine-tuning needed."]] }),
    P("p11", "Edna Sowerby", 86, "6 Town Street", "LS27", "07700 900296", { h: [["Referral", "Discharged from hospital, aids lost on ward."]] }),
    P("p12", "Walter Greaves", 77, "18 Harehills Lane", "LS8", "07700 900307"),
    P("p13", "Sylvia Moon", 82, "40 Lawnswood Gardens", "LS16", "07700 900418", { alerts: ["Key holder: neighbour at no. 42"], aids: "BTE aid, right ear", h: [["15 Feb 2026", "Review. Aid tube cracked."]] }),
    P("p14", "Frank Dobson", 74, "11 Beeston Road", "LS11", "07700 900529"),
    P("p15", "Nora Pickles", 87, "22 Cross Gates Road", "LS15", "07700 900630", { aids: "RIC aids, both ears" }),
    P("p16", "Gerald Wray", 80, "5 Shadwell Lane", "LS17", "07700 900731", { h: [["Referral", "GP: sudden worsening right ear. Prioritise."]] }),
  ];
  for (const p of patients) {
    const h = p._h; delete p._h;
    ins("patients", p);
    h.forEach(([label, body]) => ins("notes", { patient_id: p.id, label, body, author: null }));
  }
  const A = (id, c, p, type, h, m, status, drive) => ({ id, clinician_id: c, patient_id: p, type, start_min: h * 60 + m, status, drive });
  [
    A("a1", "c1", "p1", "review", 9, 0, "done", 0), A("a2", "c1", "p3", "wax", 9, 50, "live", 14),
    A("a3", "c1", "p2", "fit", 11, 0, "booked", 11), A("a4", "c1", "p4", "assess", 13, 30, "booked", 16), A("a5", "c1", "p8", "wax", 15, 0, "booked", 9),
    A("b1", "c2", "p6", "follow", 9, 15, "done", 0), A("b2", "c2", "p7", "assess", 10, 30, "booked", 18), A("b3", "c2", "p12", "assess", 13, 0, "booked", 10), A("b4", "c2", "p15", "review", 14, 45, "booked", 12),
    A("d1", "c3", "p10", "follow", 9, 30, "done", 0), A("d2", "c3", "p14", "assess", 11, 0, "booked", 15), A("d3", "c3", "p11", "fit", 13, 45, "booked", 20),
  ].forEach((r) => ins("appointments", r));
  [
    { id: "w1", patient_id: "p16", type: "assess", prio: "urgent", days: 3, avail: "any", short_notice: 1, pref_clinician_id: null },
    { id: "w2", patient_id: "p5", type: "fit", prio: "soon", days: 12, avail: "any", short_notice: 1, pref_clinician_id: "c1" },
    { id: "w3", patient_id: "p9", type: "review", prio: "soon", days: 9, avail: "pm", short_notice: 1, pref_clinician_id: null },
    { id: "w4", patient_id: "p13", type: "review", prio: "routine", days: 21, avail: "any", short_notice: 1, pref_clinician_id: null },
    { id: "w5", patient_id: "p11", type: "wax", prio: "routine", days: 6, avail: "am", short_notice: 0, pref_clinician_id: null },
    { id: "w6", patient_id: "p15", type: "wax", prio: "routine", days: 15, avail: "any", short_notice: 1, pref_clinician_id: "c2" },
  ].forEach((r) => ins("waitlist", r));
  ins("audit", { actor: "system", action: "seed", entity: "database", detail: "Demo data loaded" });
  db.exec("COMMIT");
}

const hasData = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='clinicians'").get();
if (!hasData) reset();

// Row mappers: database shape → API shape
const J = (s, d) => { try { return s == null ? d : JSON.parse(s); } catch { return d; } };
const map = {
  clinician: (r) => ({ id: r.id, name: r.name, first: r.first, role: r.role, color: r.color, areaName: r.area_name, patch: J(r.patch, []), near: J(r.near, []) }),
  patient: (r) => ({ id: r.id, name: r.name, age: r.age, addr: r.addr, pc: r.pc, phone: r.phone, contact: r.contact, alerts: J(r.alerts, []), aids: r.aids, audio: J(r.audio, null) }),
  appt: (r) => ({ id: r.id, clinicianId: r.clinician_id, patientId: r.patient_id, type: r.type, start: r.start_min, drive: r.drive, status: r.status, moved: !!r.moved, seen: !!r.seen, note: r.note, reason: r.reason, gap: !!r.gap }),
  wait: (r) => ({ id: r.id, patientId: r.patient_id, type: r.type, prio: r.prio, days: r.days, avail: r.avail, shortNotice: !!r.short_notice, prefClinicianId: r.pref_clinician_id, status: r.status }),
  msg: (r) => ({ id: r.id, dir: r.direction, name: r.to_name, phone: r.phone, body: r.body, kind: r.kind, toClin: r.to_clinician_id, fromClin: r.from_clinician_id, read: !!r.read, at: r.created_at, providerId: r.provider_id }),
  note: (r) => ({ id: r.id, label: r.label, body: r.body, by: r.author, at: r.created_at }),
};

module.exports = { db, reset, map, TABLES, FILE };
