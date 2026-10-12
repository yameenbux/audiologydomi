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
  contact TEXT NOT NULL DEFAULT 'Text', alerts TEXT NOT NULL DEFAULT '[]', specs TEXT NOT NULL DEFAULT 'None on record', rx TEXT,
  dob TEXT, email TEXT,
  eligibility TEXT,                               -- the condition that stops them leaving home unaccompanied (needed on a GOS 6)
  rep TEXT,                                       -- next of kin or carer, and their number
  last_test TEXT                                  -- date of the last sight test, ISO
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
CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY, number TEXT NOT NULL UNIQUE, appointment_id TEXT UNIQUE REFERENCES appointments(id),
  patient_id TEXT NOT NULL REFERENCES patients(id), items TEXT NOT NULL, total_pence INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'unpaid' CHECK (status IN ('unpaid','paid','void')), method TEXT,
  issued_at TEXT NOT NULL, issued_day INTEGER NOT NULL DEFAULT 0, paid_at TEXT
);
CREATE TABLE IF NOT EXISTS recalls (
  id TEXT PRIMARY KEY, patient_id TEXT NOT NULL REFERENCES patients(id), type TEXT NOT NULL, reason TEXT NOT NULL,
  due_day INTEGER NOT NULL,                       -- days from today; negative = overdue
  status TEXT NOT NULL DEFAULT 'due' CHECK (status IN ('due','texted','booked','dismissed')),
  waitlist_id TEXT, texted_at TEXT
);
CREATE TABLE IF NOT EXISTS waitlist (
  id TEXT PRIMARY KEY, patient_id TEXT NOT NULL REFERENCES patients(id), type TEXT NOT NULL, prio TEXT NOT NULL,
  days INTEGER NOT NULL DEFAULT 0, avail TEXT NOT NULL DEFAULT 'any', short_notice INTEGER NOT NULL DEFAULT 1,
  pref_clinician_id TEXT, status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','offered','booked')),
  added_seq INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'list' CHECK (source IN ('list','recall')), note TEXT
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
-- What the office has to tell PCSE: lodge a pre-visit notification for a new NHS sight test, or cancel one
-- for a visit that won't happen. Domi lists them; the office does them in PCSE Online and ticks them off.
CREATE TABLE IF NOT EXISTS pcse (
  id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT NOT NULL CHECK (action IN ('lodge','cancel')),
  patient_id TEXT NOT NULL REFERENCES patients(id), appointment_id TEXT NOT NULL REFERENCES appointments(id),
  day INTEGER NOT NULL, start_min INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','done')),
  created_at TEXT NOT NULL, done_by TEXT
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
  { id: "u-admin", email: "sarah@airevalleyeyecare.example", name: "Sarah Lane", role: "admin", clinicianId: null, title: "Office manager", color: "#C9714A" },
  { id: "u-c1", email: "amira@airevalleyeyecare.example", name: "Amira Shah", role: "clinician", clinicianId: "c1", title: "Optometrist", color: "#1E4D40" },
  { id: "u-c2", email: "tom@airevalleyeyecare.example", name: "Tom Whitfield", role: "clinician", clinicianId: "c2", title: "Dispensing optician", color: "#3F6E8C" },
  { id: "u-c3", email: "priya@airevalleyeyecare.example", name: "Priya Nair", role: "clinician", clinicianId: "c3", title: "Optometrist", color: "#7A5A8C" },
];

const TABLES = ["audit", "pcse", "messages", "offers", "notes", "invoices", "appointments", "recalls", "waitlist", "users", "patients", "clinicians"];

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
    { id: "c1", name: "Amira Shah", first: "Amira", role: "Optometrist", color: "#1E4D40", area_name: "North Leeds", patch: ["LS6", "LS16", "LS17"], near: ["LS7", "LS18", "LS8"], base: "LS6 4AA" },
    { id: "c2", name: "Tom Whitfield", first: "Tom", role: "Dispensing optician", color: "#3F6E8C", area_name: "East Leeds", patch: ["LS8", "LS9", "LS15"], near: ["LS7", "LS14", "LS26"], base: "LS8 2RS" },
    { id: "c3", name: "Priya Nair", first: "Priya", role: "Optometrist", color: "#7A5A8C", area_name: "South & West", patch: ["LS11", "LS12", "LS27"], near: ["LS13", "LS10", "LS28"], base: "LS12 3TL" },
  ].forEach((r) => ins("clinicians", r));
  // Every demo gets its own two-factor secrets; the password is the shared demo one (hashed once at start-up).
  USERS.forEach((u) => ins("users", { id: u.id, name: u.name, role: u.role, clinician_id: u.clinicianId, email: u.email, pass_hash: auth.DEMO_HASH, totp_secret: auth.newSecret() }));

  // rx: the last prescription, per eye: sphere, cylinder, axis, reading addition, and corrected acuity.
  const RX = (date, R, L) => ({ date, R: { sph: R[0], cyl: R[1], axis: R[2], add: R[3], va: R[4] }, L: { sph: L[0], cyl: L[1], axis: L[2], add: L[3], va: L[4] } });
  const P = (id, name, age, addr, pc, phone, o = {}) => ({ id, name, age, addr, pc, phone, contact: o.contact || "Text", alerts: o.alerts || [], specs: o.specs || "None on record", rx: o.rx || null, _h: o.h || [] });
  const patients = [
    P("p1", "Dorothy Fenwick", 84, "12 Weetwood Lane", "LS16 7SN", "07700 900112", { alerts: ["Daughter Julie present for visits"], specs: "Varifocals (2024)", rx: RX("10 Oct 2024", ["+2.25", "-0.75", "90", "+2.75", "6/9"], ["+2.00", "-0.50", "85", "+2.75", "6/9"]), h: [["10 Oct 2024", "NHS sight test. Early cataract both eyes, monitoring. New varifocals."]] }),
    P("p2", "Peter Dunn", 79, "3 Otley Road, Headingley", "LS6 4DH", "07700 900245", { contact: "Call", alerts: ["Macular degeneration: can't read texts, call him"], specs: "Single vision distance and reading", rx: RX("29 Sep 2026", ["+1.50", "-1.00", "175", "+3.00", "6/18"], ["+1.75", "-0.75", "5", "+3.00", "6/12"]), h: [["29 Sep 2026", "NHS sight test. Dry AMD right eye, stable. Two pairs ordered, back from the lab."]] }),
    P("p3", "Hilda Marsh", 91, "Flat 4, Moor Court", "LS17 7LH", "07700 900318", { alerts: ["Care home: sign in at reception", "Uses wheelchair"], specs: "Bifocals", rx: RX("2 Jul 2026", ["+3.00", "-0.50", "100", "+3.00", "6/12"], ["+3.25", "", "", "+3.00", "6/12"]), h: [["2 Jul 2026", "NHS sight test. Pseudophakic both eyes. Bifocals fitted."], ["8 Oct 2026", "Care home called: left arm snapped."]] }),
    P("p4", "Ken Ollerton", 72, "28 Spen Lane", "LS16 8DF", "07700 900427", { h: [["Referral", "GP referral: housebound after a stroke, last test 2023."]] }),
    P("p5", "Margaret Holt", 81, "14 Ash Grove", "LS6 4FH", "07700 900533", { alerts: ["Hard of hearing: text, don't call"], specs: "Varifocals (new pair at the lab)", rx: RX("28 Sep 2026", ["-1.25", "-0.75", "20", "+2.50", "6/6"], ["-1.50", "-0.50", "160", "+2.50", "6/9"]), h: [["28 Sep 2026", "NHS sight test. Change in Rx. New varifocals ordered, ready to deliver."]] }),
    P("p6", "Arthur Pell", 88, "7 Easterly Road", "LS8 2RS", "07700 900641", { specs: "Varifocals", h: [["12 Oct 2026", "Glasses delivered and fitted. Comfortable."]] }),
    P("p7", "June Akroyd", 76, "51 Selby Road", "LS15 8ES", "07700 900752", { specs: "Reading glasses", h: [["Referral", "Nose pads broken, glasses slipping."]] }),
    P("p8", "Stanley Rhodes", 83, "2 Kirkstall Hill", "LS6 4AA", "07700 900863", { alerts: ["Wife Brenda answers door"], specs: "Varifocals", h: [["14 Aug 2026", "Raised eye pressures (IOP 24 R, 23 L). Recheck in 8 weeks."]] }),
    P("p9", "Irene Battye", 90, "9 Moor Allerton Drive", "LS17 7LQ", "07700 900974", { alerts: ["Carer visits 10:00–10:30"], specs: "Bifocals", h: [["Referral", "Daughter reports glasses keep sliding down."]] }),
    P("p10", "Brian Clegg", 69, "33 Tong Road", "LS12 3TL", "07700 900185", { specs: "Single vision distance", h: [["5 Aug 2026", "Private eye exam. Fundus photos, all clear."]] }),
    P("p11", "Edna Sowerby", 86, "6 Town Street", "LS27 8DW", "07700 900296", { specs: "Lost on ward", h: [["Referral", "Discharged from hospital, glasses lost on the ward."]] }),
    P("p12", "Walter Greaves", 77, "18 Harehills Lane", "LS8 4AR", "07700 900307", { specs: "Varifocals (new pair at the lab)" }),
    P("p13", "Sylvia Moon", 82, "40 Lawnswood Gardens", "LS16 8DG", "07700 900418", { alerts: ["Key holder: neighbour at no. 42"], specs: "Varifocals", h: [["15 Jul 2026", "Glaucoma suspect: fields borderline. Recheck in 3 months."]] }),
    P("p14", "Frank Dobson", 74, "11 Beeston Road", "LS11 8QU", "07700 900529"),
    P("p15", "Nora Pickles", 87, "22 Cross Gates Road", "LS15 8BX", "07700 900630", { specs: "Bifocals", h: [["Referral", "Screw lost from the hinge."]] }),
    P("p16", "Gerald Wray", 80, "5 Shadwell Lane", "LS17 7LG", "07700 900731", { h: [["Referral", "GP: vision worse over a month, can't leave home. Prioritise."]] }),
    // Patients booked later in the week
    P("p20", "Vera Hollins", 79, "17 Shaw Lane", "LS6 4FH", "07700 900142", { specs: "Varifocals" }),
    P("p21", "Douglas Firth", 85, "4 Adel Park Croft", "LS16 8DE", "07700 900253"),
    P("p22", "Joan Bairstow", 88, "Flat 2, 210 Harrogate Road", "LS17 7QN", "07700 900364", { alerts: ["Lives alone: slow to answer the door"], specs: "Reading glasses" }),
    P("p23", "Harold Beecroft", 73, "29 Kingsway", "LS16 8DU", "07700 900475"),
    P("p24", "Phyllis Dransfield", 91, "Ryecroft Care Home", "LS17 7PW", "07700 900586", { alerts: ["Care home: ask for room 12"], specs: "Bifocals" }),
    P("p25", "Ronald Hepworth", 82, "12 Oakwood Lane", "LS8 2JA", "07700 900697", { specs: "Varifocals" }),
    P("p26", "Mavis Sutcliffe", 86, "3 Austhorpe Road", "LS15 7UD", "07700 900708"),
    P("p27", "Clifford Booth", 70, "21 Torre Road", "LS9 7QL", "07700 900819"),
    P("p28", "Eileen Marsden", 84, "7 Manston Lane", "LS15 7RX", "07700 900920", { alerts: ["Hard of hearing: text, don't call"] }),
    P("p29", "Norman Pickard", 81, "14 Cottingley Drive", "LS11 7BQ", "07700 900131"),
    P("p30", "Doreen Whiteley", 89, "9 Wortley Road", "LS12 2AX", "07700 900242", { alerts: ["Son Mark reads her texts to her"], specs: "Varifocals" }),
    P("p31", "Kenneth Rawnsley", 77, "40 Fountain Street", "LS27 0EW", "07700 900353", { specs: "Varifocals", h: [["Referral", "Frame cracked. Needs a day's notice: works mornings at the church."]] }),
    // Due a recall (no visit booked yet)
    P("p40", "Brenda Kitson", 83, "15 Holt Park Way", "LS16 8DU", "07700 900464", { specs: "Varifocals (2024)" }),
    P("p41", "Geoffrey Lumb", 78, "3 Alwoodley Lane", "LS17 7QN", "07700 900575", { specs: "Bifocals", h: [["14 Apr 2026", "Ocular hypertension. Pressures recheck in 6 months."]] }),
    P("p42", "Pauline Rigg", 80, "62 Halton Moor Road", "LS15 7UD", "07700 900686", { specs: "Varifocals" }),
    P("p43", "Dennis Marlow", 75, "9 Armley Ridge Road", "LS12 2AX", "07700 900797", { specs: "Reading glasses" }),
  ];
  for (const p of patients) {
    const h = p._h; delete p._h;
    ins("patients", p);
    h.forEach(([label, body]) => ins("notes", { patient_id: p.id, label, body, author: null, created_at: "" }));
  }
  const pcOf = Object.fromEntries(patients.map((p) => [p.id, p.pc]));
  const A = (id, c, p, type, h, m, status) => ({ id, clinician_id: c, patient_id: p, type, start_min: h * 60 + m, status });
  // Today. Tom is a dispensing optician, so his round is deliveries and repairs; sight tests go to Amira and Priya.
  [
    A("a1", "c1", "p1", "sight", 9, 0, "done"), A("a2", "c1", "p3", "repair", 10, 10, "live"),
    A("a3", "c1", "p2", "dispense", 11, 0, "booked"), A("a4", "c1", "p4", "sight", 13, 30, "booked"), A("a5", "c1", "p8", "follow", 15, 0, "booked"),
    A("b1", "c2", "p6", "dispense", 9, 15, "done"), A("b2", "c2", "p7", "repair", 10, 30, "booked"), A("b3", "c2", "p12", "dispense", 13, 0, "booked"), A("b4", "c2", "p15", "repair", 14, 45, "booked"),
    A("d1", "c3", "p10", "follow", 9, 30, "done"), A("d2", "c3", "p14", "sight", 11, 0, "booked"), A("d3", "c3", "p11", "sight", 13, 45, "booked"),
  ].forEach((r, i, today) => {
    // Drive from the previous visit in the same round (the first visit of the day starts from home).
    const prev = today.slice(0, i).reverse().find((x) => x.clinician_id === r.clinician_id);
    const drive = prev ? driveMinutes(pcOf[prev.patient_id], pcOf[r.patient_id]) || 10 : 0;
    ins("appointments", { ...r, day: 0, drive });
  });

  // Tuesday to Friday: four regular slots per clinician, with a different one left free each day
  // so there is always room to book into. Drives are worked out from the previous stop.
  // The NHS sight tests already booked were notified to PCSE when they were booked.
  const pools = { c1: ["p20", "p21", "p22", "p23", "p24", "p2"], c2: ["p25", "p26", "p27", "p28", "p12", "p6"], c3: ["p29", "p30", "p31", "p10", "p14"] };
  const bases = { c1: "LS6 4AA", c2: "LS8 2RS", c3: "LS12 3TL" };
  const OPTOM_SLOTS = [[540, "sight"], [645, "dispense"], [780, "sight"], [900, "follow"]];
  const DISPENSER_SLOTS = [[540, "dispense"], [645, "repair"], [780, "dispense"], [900, "repair"]];
  for (let day = 1; day <= 4; day++) {
    for (const [ci, cid] of ["c1", "c2", "c3"].entries()) {
      let prev = bases[cid];
      (cid === "c2" ? DISPENSER_SLOTS : OPTOM_SLOTS).forEach(([start, type], i) => {
        if (i === (day + ci) % 4) return; // the free slot
        const pool = pools[cid];
        const pid = pool[(day * 3 + i + ci) % pool.length];
        const drive = i === 0 ? 0 : driveMinutes(prev, pcOf[pid]) || 10;
        ins("appointments", { id: `w${day}${cid}${i}`, clinician_id: cid, patient_id: pid, type, day, start_min: start, status: "booked", drive });
        prev = pcOf[pid];
      });
    }
  }
  [
    { id: "w1", patient_id: "p16", type: "sight", prio: "urgent", days: 3, avail: "any", short_notice: 1, pref_clinician_id: null },
    { id: "w2", patient_id: "p5", type: "dispense", prio: "soon", days: 12, avail: "any", short_notice: 1, pref_clinician_id: "c1" },
    { id: "w3", patient_id: "p9", type: "repair", prio: "soon", days: 9, avail: "pm", short_notice: 1, pref_clinician_id: null },
    { id: "w4", patient_id: "p13", type: "follow", prio: "routine", days: 21, avail: "any", short_notice: 1, pref_clinician_id: null },
    { id: "w5", patient_id: "p31", type: "repair", prio: "routine", days: 6, avail: "am", short_notice: 0, pref_clinician_id: null },
    { id: "w6", patient_id: "p15", type: "repair", prio: "routine", days: 15, avail: "any", short_notice: 1, pref_clinician_id: "c2" },
  ].forEach((r, i) => ins("waitlist", { ...r, added_seq: i }));
  // Recalls due within two weeks join the refill pool, so a cancellation can be filled by someone due a test anyway.
  // due_day: days from today (negative = overdue). NHS sight tests are every two years, or yearly from 70.
  [
    { id: "r1", patient_id: "p40", type: "sight", reason: "Yearly NHS sight test (over 70)", due_day: -12 },
    { id: "r2", patient_id: "p41", type: "follow", reason: "6-month pressures recheck", due_day: -3 },
    { id: "r3", patient_id: "p42", type: "sight", reason: "Yearly NHS sight test (over 70)", due_day: 5 },
    { id: "r4", patient_id: "p43", type: "sight", reason: "Yearly NHS sight test (over 70)", due_day: 9 },
  ].forEach((r, i) => {
    const wid = "wr" + r.id.slice(1);
    ins("waitlist", { id: wid, patient_id: r.patient_id, type: r.type, prio: "routine", days: Math.max(0, -r.due_day), avail: "any", short_notice: 1, pref_clinician_id: null, added_seq: 100 + i, source: "recall", note: r.reason });
    ins("recalls", { ...r, waitlist_id: wid });
  });
  ins("audit", { ts: "10:20:00", actor: "system", action: "seed", entity: "database", detail: "Demo data loaded" });
  db.exec("COMMIT");
}

sandbox.setOpener(openDb);

// Row mappers: database shape → API shape
const J = (s, d) => { try { return s == null ? d : JSON.parse(s); } catch { return d; } };
const map = {
  clinician: (r) => ({ id: r.id, name: r.name, first: r.first, role: r.role, optom: r.role === "Optometrist", color: r.color, areaName: r.area_name, patch: J(r.patch, []), near: J(r.near, []), base: r.base }),
  patient: (r) => ({ id: r.id, name: r.name, age: r.age, addr: r.addr, pc: r.pc, phone: r.phone, contact: r.contact, alerts: J(r.alerts, []), specs: r.specs, rx: J(r.rx, null), dob: r.dob, email: r.email, eligibility: r.eligibility, rep: r.rep, lastTest: r.last_test }),
  appt: (r) => ({ id: r.id, clinicianId: r.clinician_id, patientId: r.patient_id, type: r.type, day: r.day, start: r.start_min, drive: r.drive, status: r.status, moved: !!r.moved, seen: !!r.seen, note: r.note, reason: r.reason, gap: !!r.gap, cancelledMin: r.cancelled_min, bookedMin: r.booked_min, filledFrom: r.filled_from, reminded: !!r.reminded }),
  wait: (r) => ({ id: r.id, patientId: r.patient_id, type: r.type, prio: r.prio, days: r.days, avail: r.avail, shortNotice: !!r.short_notice, prefClinicianId: r.pref_clinician_id, status: r.status, source: r.source || "list", note: r.note || null }),
  invoice: (r) => ({ id: r.id, number: r.number, appointmentId: r.appointment_id, patientId: r.patient_id, items: J(r.items, []), totalPence: r.total_pence, status: r.status, method: r.method, issuedAt: r.issued_at, issuedDay: r.issued_day, paidAt: r.paid_at }),
  recall: (r) => ({ id: r.id, patientId: r.patient_id, type: r.type, reason: r.reason, dueDay: r.due_day, status: r.status, waitlistId: r.waitlist_id, textedAt: r.texted_at }),
  msg: (r) => ({ id: r.id, dir: r.direction, name: r.to_name, phone: r.phone, body: r.body, kind: r.kind, toClin: r.to_clinician_id, fromClin: r.from_clinician_id, read: !!r.read, at: r.created_at, providerId: r.provider_id }),
  pcse: (r) => ({ id: r.id, action: r.action, patientId: r.patient_id, appointmentId: r.appointment_id, day: r.day, start: r.start_min, status: r.status, at: r.created_at, by: r.done_by }),
  note: (r) => ({ id: r.id, label: r.label, body: r.body, by: r.author, at: r.created_at }),
};

module.exports = { db, openDb, map, TABLES, USERS };
