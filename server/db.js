"use strict";
// SQLite via Node's built-in driver. Each demo sandbox gets its own in-memory database, seeded fresh,
// so visitors never see or change each other's data. In production this becomes one Postgres database.
const { DatabaseSync } = require("node:sqlite");
const sandbox = require("./sandbox");
const { driveMinutes } = require("./travel");
const auth = require("./auth");

// `db` always points at the database of the sandbox handling the current request.
const db = new Proxy({}, {
  get(_, key) { const real = sandbox.current().db; const v = real[key]; return typeof v === "function" ? v.bind(real) : v; },
});

const SCHEMA = `
CREATE TABLE IF NOT EXISTS clinicians (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, first TEXT NOT NULL, role TEXT NOT NULL, color TEXT NOT NULL,
  area_name TEXT NOT NULL, patch TEXT NOT NULL, near TEXT NOT NULL, base TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('admin','clinician')),
  clinician_id TEXT REFERENCES clinicians(id),
  email TEXT NOT NULL UNIQUE, pass_hash TEXT NOT NULL, totp_secret TEXT NOT NULL,
  totp_step INTEGER NOT NULL DEFAULT -1,            -- last code step used, so a code can't be replayed
  failed INTEGER NOT NULL DEFAULT 0, locked_until INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS patients (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, age INTEGER, addr TEXT NOT NULL, pc TEXT NOT NULL, phone TEXT NOT NULL,
  contact TEXT NOT NULL DEFAULT 'Text', alerts TEXT NOT NULL DEFAULT '[]', aids TEXT NOT NULL DEFAULT 'None yet', audio TEXT
);
CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT, patient_id TEXT NOT NULL REFERENCES patients(id), label TEXT NOT NULL,
  body TEXT NOT NULL, author TEXT, created_at TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS appointments (
  id TEXT PRIMARY KEY, clinician_id TEXT NOT NULL REFERENCES clinicians(id), patient_id TEXT NOT NULL REFERENCES patients(id),
  type TEXT NOT NULL, day INTEGER NOT NULL DEFAULT 0, start_min INTEGER NOT NULL, drive INTEGER NOT NULL DEFAULT 10,
  status TEXT NOT NULL CHECK (status IN ('booked','enroute','live','done','cancelled')),
  moved INTEGER NOT NULL DEFAULT 0, seen INTEGER NOT NULL DEFAULT 0, note TEXT, reason TEXT, gap INTEGER NOT NULL DEFAULT 0,
  cancelled_min INTEGER, booked_min INTEGER, filled_from TEXT,
  reminded INTEGER NOT NULL DEFAULT 0              -- day-before reminder sent
);
CREATE TABLE IF NOT EXISTS waitlist (
  id TEXT PRIMARY KEY, patient_id TEXT NOT NULL REFERENCES patients(id), type TEXT NOT NULL, prio TEXT NOT NULL,
  days INTEGER NOT NULL DEFAULT 0, avail TEXT NOT NULL DEFAULT 'any', short_notice INTEGER NOT NULL DEFAULT 1,
  pref_clinician_id TEXT, status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','offered','booked')),
  added_seq INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS offers (
  id INTEGER PRIMARY KEY AUTOINCREMENT, slot_id TEXT NOT NULL REFERENCES appointments(id), waitlist_id TEXT NOT NULL REFERENCES waitlist(id),
  status TEXT NOT NULL CHECK (status IN ('pending','accepted','declined','expired','superseded')),
  score INTEGER, round INTEGER NOT NULL DEFAULT 1, sent_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, deadline TEXT, booked_appointment_id TEXT
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, direction TEXT NOT NULL CHECK (direction IN ('out','in')),
  to_name TEXT, phone TEXT, body TEXT NOT NULL, kind TEXT NOT NULL, to_clinician_id TEXT, from_clinician_id TEXT,
  provider_id TEXT, read INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, actor TEXT NOT NULL,
  action TEXT NOT NULL, entity TEXT, detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_appt_clin ON appointments(clinician_id, day, start_min);
CREATE INDEX IF NOT EXISTS idx_offer_pending ON offers(status, expires_at);
`;

// Demo sign-in accounts. Static, so the sign-in screen can list them before a sandbox exists.
const USERS = [
  { id: "u-admin", email: "sarah@domi-hearing.example", name: "Sarah Lane", role: "admin", clinicianId: null, title: "Office manager", color: "#C9714A" },
  { id: "u-c1", email: "amira@domi-hearing.example", name: "Amira Shah", role: "clinician", clinicianId: "c1", title: "Audiologist", color: "#1E4D40" },
  { id: "u-c2", email: "tom@domi-hearing.example", name: "Tom Whitfield", role: "clinician", clinicianId: "c2", title: "Hearing aid dispenser", color: "#3F6E8C" },
  { id: "u-c3", email: "priya@domi-hearing.example", name: "Priya Nair", role: "clinician", clinicianId: "c3", title: "Audiologist", color: "#7A5A8C" },
];

const TABLES = ["audit", "messages", "offers", "notes", "appointments", "waitlist", "users", "patients", "clinicians"];

/** A fresh, seeded in-memory database for one sandbox. */
function openDb() {
  const d = new DatabaseSync(":memory:");
  d.exec("PRAGMA foreign_keys = ON;");
  d.exec(SCHEMA);
  seed(d);
  return d;
}

function seed(db) {
  const ins = (table, row) => {
    const keys = Object.keys(row);
    db.prepare(`INSERT INTO ${table} (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`)
      .run(...keys.map((k) => (row[k] !== null && typeof row[k] === "object" ? JSON.stringify(row[k]) : row[k])));
  };
  db.exec("BEGIN");
  [
    { id: "c1", name: "Amira Shah", first: "Amira", role: "Audiologist", color: "#1E4D40", area_name: "North Leeds", patch: ["LS6", "LS16", "LS17"], near: ["LS7", "LS18", "LS8"], base: "LS6 4AA" },
    { id: "c2", name: "Tom Whitfield", first: "Tom", role: "Hearing aid dispenser", color: "#3F6E8C", area_name: "East Leeds", patch: ["LS8", "LS9", "LS15"], near: ["LS7", "LS14", "LS26"], base: "LS8 2RS" },
    { id: "c3", name: "Priya Nair", first: "Priya", role: "Audiologist", color: "#7A5A8C", area_name: "South & West", patch: ["LS11", "LS12", "LS27"], near: ["LS13", "LS10", "LS28"], base: "LS12 3TL" },
  ].forEach((r) => ins("clinicians", r));
  // Every demo gets its own two-factor secrets; the password is the shared demo one (hashed once at start-up).
  USERS.forEach((u) => ins("users", { id: u.id, name: u.name, role: u.role, clinician_id: u.clinicianId, email: u.email, pass_hash: auth.DEMO_HASH, totp_secret: auth.newSecret() }));

  const P = (id, name, age, addr, pc, phone, o = {}) => ({ id, name, age, addr, pc, phone, contact: o.contact || "Text", alerts: o.alerts || [], aids: o.aids || "None yet", audio: o.audio || null, _h: o.h || [] });
  const patients = [
    P("p1", "Dorothy Fenwick", 84, "12 Weetwood Lane", "LS16 7SN", "07700 900112", { alerts: ["Daughter Julie present for visits"], aids: "RIC aids, both ears (fitted 2024)", audio: { R: [30, 35, 45, 55, 65, 75], L: [25, 35, 40, 55, 70, 80] }, h: [["14 Mar 2026", "Annual review. Domes replaced, aids cleaned. Reports TV clearer."]] }),
    P("p2", "Peter Dunn", 79, "3 Otley Road, Headingley", "LS6 4DH", "07700 900245", { contact: "Call", aids: "BTE aid, left ear", audio: { R: [20, 25, 30, 45, 60, 70], L: [40, 45, 55, 65, 75, 85] }, h: [["2 Sep 2026", "Assessment. Moderate-severe loss left. Fitting booked."]] }),
    P("p3", "Hilda Marsh", 91, "Flat 4, Moor Court", "LS17 7LH", "07700 900318", { alerts: ["Care home: sign in at reception", "Uses wheelchair"], aids: "RIC aids, both ears", audio: { R: [45, 50, 55, 65, 75, 85], L: [45, 50, 60, 70, 80, 90] }, h: [["20 Jul 2026", "Wax removed both ears. Aids retubed."]] }),
    P("p4", "Ken Ollerton", 72, "28 Spen Lane", "LS16 8DF", "07700 900427", { h: [["Referral", "GP referral: gradual loss, struggles in groups."]] }),
    P("p5", "Margaret Holt", 81, "14 Ash Grove", "LS6 4FH", "07700 900533", { alerts: ["Hard of hearing: text, don't call"], aids: "Old BTE aids, both ears (2017)", audio: { R: [35, 40, 50, 60, 70, 80], L: [35, 45, 50, 60, 70, 75] }, h: [["28 Aug 2026", "Assessment. New aids ordered, awaiting fitting."]] }),
    P("p6", "Arthur Pell", 88, "7 Easterly Road", "LS8 2RS", "07700 900641", { aids: "RIC aid, right ear", h: [["1 May 2026", "Fitting. Good benefit reported."]] }),
    P("p7", "June Akroyd", 76, "51 Selby Road", "LS15 8ES", "07700 900752", { h: [["Referral", "Self-referral. Tinnitus left ear."]] }),
    P("p8", "Stanley Rhodes", 83, "2 Kirkstall Hill", "LS6 4AA", "07700 900863", { alerts: ["Wife Brenda answers door"], aids: "BTE aids, both ears", h: [["10 Jun 2026", "Wax impacted right. Microsuction booked."]] }),
    P("p9", "Irene Battye", 90, "9 Moor Allerton Drive", "LS17 7LQ", "07700 900974", { alerts: ["Carer visits 10:00–10:30"], h: [["Referral", "Daughter reports aids whistling."]] }),
    P("p10", "Brian Clegg", 69, "33 Tong Road", "LS12 3TL", "07700 900185", { aids: "RIC aids, both ears", h: [["5 Aug 2026", "Fitting. Fine-tuning needed."]] }),
    P("p11", "Edna Sowerby", 86, "6 Town Street", "LS27 8DW", "07700 900296", { h: [["Referral", "Discharged from hospital, aids lost on ward."]] }),
    P("p12", "Walter Greaves", 77, "18 Harehills Lane", "LS8 4AR", "07700 900307"),
    P("p13", "Sylvia Moon", 82, "40 Lawnswood Gardens", "LS16 8DG", "07700 900418", { alerts: ["Key holder: neighbour at no. 42"], aids: "BTE aid, right ear", h: [["15 Feb 2026", "Review. Aid tube cracked."]] }),
    P("p14", "Frank Dobson", 74, "11 Beeston Road", "LS11 8QU", "07700 900529"),
    P("p15", "Nora Pickles", 87, "22 Cross Gates Road", "LS15 8BX", "07700 900630", { aids: "RIC aids, both ears" }),
    P("p16", "Gerald Wray", 80, "5 Shadwell Lane", "LS17 7LG", "07700 900731", { h: [["Referral", "GP: sudden worsening right ear. Prioritise."]] }),
    // Patients booked later in the week
    P("p20", "Vera Hollins", 79, "17 Shaw Lane", "LS6 4FH", "07700 900142", { aids: "RIC aids, both ears", h: [["3 Jun 2026", "Fitting. Happy with sound quality."]] }),
    P("p21", "Douglas Firth", 85, "4 Adel Park Croft", "LS16 8DE", "07700 900253"),
    P("p22", "Joan Bairstow", 88, "Flat 2, 210 Harrogate Road", "LS17 7QN", "07700 900364", { alerts: ["Lives alone: slow to answer the door"], aids: "BTE aid, left ear" }),
    P("p23", "Harold Beecroft", 73, "29 Kingsway", "LS16 8DU", "07700 900475"),
    P("p24", "Phyllis Dransfield", 91, "Ryecroft Care Home", "LS17 7PW", "07700 900586", { alerts: ["Care home: ask for room 12"], aids: "RIC aids, both ears" }),
    P("p25", "Ronald Hepworth", 82, "12 Oakwood Lane", "LS8 2JA", "07700 900697", { aids: "BTE aids, both ears" }),
    P("p26", "Mavis Sutcliffe", 86, "3 Austhorpe Road", "LS15 7UD", "07700 900708"),
    P("p27", "Clifford Booth", 70, "21 Torre Road", "LS9 7QL", "07700 900819"),
    P("p28", "Eileen Marsden", 84, "7 Manston Lane", "LS15 7RX", "07700 900920", { alerts: ["Hard of hearing: text, don't call"] }),
    P("p29", "Norman Pickard", 81, "14 Cottingley Drive", "LS11 7BQ", "07700 900131"),
    P("p30", "Doreen Whiteley", 89, "9 Wortley Road", "LS12 2AX", "07700 900242", { alerts: ["Son Mark helps with her hearing aids"], aids: "RIC aids, both ears" }),
    P("p31", "Kenneth Rawnsley", 77, "40 Fountain Street", "LS27 0EW", "07700 900353"),
  ];
  for (const p of patients) {
    const h = p._h; delete p._h;
    ins("patients", p);
    h.forEach(([label, body]) => ins("notes", { patient_id: p.id, label, body, author: null, created_at: "" }));
  }
  const pcOf = Object.fromEntries(patients.map((p) => [p.id, p.pc]));
  const A = (id, c, p, type, h, m, status) => ({ id, clinician_id: c, patient_id: p, type, start_min: h * 60 + m, status });
  [
    A("a1", "c1", "p1", "review", 9, 0, "done"), A("a2", "c1", "p3", "wax", 9, 50, "live"),
    A("a3", "c1", "p2", "fit", 11, 0, "booked"), A("a4", "c1", "p4", "assess", 13, 30, "booked"), A("a5", "c1", "p8", "wax", 15, 0, "booked"),
    A("b1", "c2", "p6", "follow", 9, 15, "done"), A("b2", "c2", "p7", "assess", 10, 30, "booked"), A("b3", "c2", "p12", "assess", 13, 0, "booked"), A("b4", "c2", "p15", "review", 14, 45, "booked"),
    A("d1", "c3", "p10", "follow", 9, 30, "done"), A("d2", "c3", "p14", "assess", 11, 0, "booked"), A("d3", "c3", "p11", "fit", 13, 45, "booked"),
  ].forEach((r, i, today) => {
    // Drive from the previous visit in the same round (the first visit of the day starts from home).
    const prev = today.slice(0, i).reverse().find((x) => x.clinician_id === r.clinician_id);
    const drive = prev ? driveMinutes(pcOf[prev.patient_id], pcOf[r.patient_id]) || 10 : 0;
    ins("appointments", { ...r, day: 0, drive });
  });

  // Tuesday to Friday: four regular slots per clinician, with a different one left free each day
  // so there is always room to book into. Drives are worked out from the previous stop.
  const pools = { c1: ["p20", "p21", "p22", "p23", "p24", "p2"], c2: ["p25", "p26", "p27", "p28", "p12", "p6"], c3: ["p29", "p30", "p31", "p10", "p14"] };
  const bases = { c1: "LS6 4AA", c2: "LS8 2RS", c3: "LS12 3TL" };
  const SLOTS = [[540, "assess"], [645, "wax"], [780, "fit"], [900, "review"]];
  let n = 0;
  for (let day = 1; day <= 4; day++) {
    for (const [ci, cid] of ["c1", "c2", "c3"].entries()) {
      let prev = bases[cid];
      SLOTS.forEach(([start, type], i) => {
        if (i === (day + ci) % 4) return; // the free slot
        const pool = pools[cid];
        const pid = pool[(day * 3 + i + ci) % pool.length];
        const drive = i === 0 ? 0 : driveMinutes(prev, pcOf[pid]) || 10;
        ins("appointments", { id: `w${day}${cid}${i}`, clinician_id: cid, patient_id: pid, type, day, start_min: start, status: "booked", drive });
        prev = pcOf[pid]; n++;
      });
    }
  }
  [
    { id: "w1", patient_id: "p16", type: "assess", prio: "urgent", days: 3, avail: "any", short_notice: 1, pref_clinician_id: null },
    { id: "w2", patient_id: "p5", type: "fit", prio: "soon", days: 12, avail: "any", short_notice: 1, pref_clinician_id: "c1" },
    { id: "w3", patient_id: "p9", type: "review", prio: "soon", days: 9, avail: "pm", short_notice: 1, pref_clinician_id: null },
    { id: "w4", patient_id: "p13", type: "review", prio: "routine", days: 21, avail: "any", short_notice: 1, pref_clinician_id: null },
    { id: "w5", patient_id: "p11", type: "wax", prio: "routine", days: 6, avail: "am", short_notice: 0, pref_clinician_id: null },
    { id: "w6", patient_id: "p15", type: "wax", prio: "routine", days: 15, avail: "any", short_notice: 1, pref_clinician_id: "c2" },
  ].forEach((r, i) => ins("waitlist", { ...r, added_seq: i }));
  ins("audit", { ts: "10:20:00", actor: "system", action: "seed", entity: "database", detail: "Demo data loaded" });
  db.exec("COMMIT");
}

sandbox.setOpener(openDb);

// Row mappers: database shape → API shape
const J = (s, d) => { try { return s == null ? d : JSON.parse(s); } catch { return d; } };
const map = {
  clinician: (r) => ({ id: r.id, name: r.name, first: r.first, role: r.role, color: r.color, areaName: r.area_name, patch: J(r.patch, []), near: J(r.near, []), base: r.base }),
  patient: (r) => ({ id: r.id, name: r.name, age: r.age, addr: r.addr, pc: r.pc, phone: r.phone, contact: r.contact, alerts: J(r.alerts, []), aids: r.aids, audio: J(r.audio, null) }),
  appt: (r) => ({ id: r.id, clinicianId: r.clinician_id, patientId: r.patient_id, type: r.type, day: r.day, start: r.start_min, drive: r.drive, status: r.status, moved: !!r.moved, seen: !!r.seen, note: r.note, reason: r.reason, gap: !!r.gap, cancelledMin: r.cancelled_min, bookedMin: r.booked_min, filledFrom: r.filled_from, reminded: !!r.reminded }),
  wait: (r) => ({ id: r.id, patientId: r.patient_id, type: r.type, prio: r.prio, days: r.days, avail: r.avail, shortNotice: !!r.short_notice, prefClinicianId: r.pref_clinician_id, status: r.status }),
  msg: (r) => ({ id: r.id, dir: r.direction, name: r.to_name, phone: r.phone, body: r.body, kind: r.kind, toClin: r.to_clinician_id, fromClin: r.from_clinician_id, read: !!r.read, at: r.created_at, providerId: r.provider_id }),
  note: (r) => ({ id: r.id, label: r.label, body: r.body, by: r.author, at: r.created_at }),
};

module.exports = { db, openDb, map, TABLES, USERS };
