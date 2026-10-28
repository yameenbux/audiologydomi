"use strict";
// SQLite via Node's built-in driver. Each demo sandbox gets its own in-memory database, seeded fresh,
// so visitors never see or change each other's data. In production this becomes one Postgres database.
const { DatabaseSync } = require("node:sqlite");
const sandbox = require("./sandbox");
const { driveMinutes } = require("./travel");
const auth = require("./auth");
const travel = require("./travel");
const { northWest } = require("./seed-nw");
const { DAY_START, DAY_END } = require("./domain");
const sectors = require("./sectors");
const brands = require("./brands");

// `db` always points at the database of the sandbox handling the current request.
const db = new Proxy({}, {
  get(_, key) { const real = sandbox.current().db; const v = real[key]; return typeof v === "function" ? v.bind(real) : v; },
});

// A full working day, Monday to Friday. A clinician's own hours can be shorter, or a day off (null).
const DEFAULT_HOURS = [0, 1, 2, 3, 4].map(() => [DAY_START, DAY_END]);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS clinicians (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, first TEXT NOT NULL, role TEXT NOT NULL, color TEXT NOT NULL,
  area_name TEXT NOT NULL, patch TEXT NOT NULL, near TEXT NOT NULL, base TEXT NOT NULL,
  hours TEXT NOT NULL DEFAULT '${JSON.stringify(DEFAULT_HOURS)}', -- per weekday Mon–Fri: [start, end] in minutes, or null for a day off
  active INTEGER NOT NULL DEFAULT 1                -- 0 once they've left: kept for history, never offered work
);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('admin','clinician')),
  clinician_id TEXT REFERENCES clinicians(id),
  email TEXT NOT NULL UNIQUE, pass_hash TEXT NOT NULL, totp_secret TEXT NOT NULL,
  totp_step INTEGER NOT NULL DEFAULT -1,            -- last code step used, so a code can't be replayed
  failed INTEGER NOT NULL DEFAULT 0, locked_until INTEGER NOT NULL DEFAULT 0,
  title TEXT, color TEXT,
  active INTEGER NOT NULL DEFAULT 1,               -- 0 = can't sign in (left the practice); kept for the audit trail
  office INTEGER NOT NULL DEFAULT 0                -- a clinician who also runs the practice (a director): office access too
);
CREATE TABLE IF NOT EXISTS diary_log (           -- diary changes to copy into another system (Opticabase), until it can sync
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  appointment_id TEXT NOT NULL REFERENCES appointments(id),
  change TEXT NOT NULL CHECK (change IN ('booked','moved','cancelled','not-seen')),
  at TEXT NOT NULL,                                 -- when it changed: YYYY-MM-DD HH:MM, UK time
  patient_id TEXT NOT NULL, visit_date TEXT NOT NULL, visit_time TEXT NOT NULL, clinician TEXT NOT NULL, type TEXT NOT NULL,
  was_date TEXT, was_time TEXT, was_clinician TEXT, -- a move: where it was before
  reason TEXT, copied_at TEXT, copied_by TEXT
);
CREATE TABLE IF NOT EXISTS confirmations (       -- confirmation calls (CC1-CC3), one row per call made
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  appointment_id TEXT NOT NULL REFERENCES appointments(id),
  stage INTEGER NOT NULL CHECK (stage IN (1,2,3)),
  outcome TEXT NOT NULL CHECK (outcome IN ('done','no-answer','texted')),
  by_name TEXT NOT NULL, at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY,                             -- a hash of the token in the link: the link itself is never stored
  user_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('invite','reset')),
  created_by TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  used_at INTEGER, revoked INTEGER NOT NULL DEFAULT 0, tries INTEGER NOT NULL DEFAULT 0,
  pass_hash TEXT, totp_secret TEXT                 -- chosen during set-up; kept here until a first code proves the app works
);
CREATE TABLE IF NOT EXISTS patients (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, age INTEGER, addr TEXT NOT NULL, pc TEXT NOT NULL, phone TEXT NOT NULL,
  contact TEXT NOT NULL DEFAULT 'Text', alerts TEXT NOT NULL DEFAULT '[]', specs TEXT NOT NULL DEFAULT 'None on record', rx TEXT,
  dob TEXT, email TEXT,
  eligibility TEXT,                               -- the condition that stops them leaving home unaccompanied (needed on a GOS 6)
  rep TEXT,                                       -- next of kin or carer, and their number
  poa TEXT,                                       -- who holds lasting power of attorney (health and welfare), and how to reach them
  share TEXT CHECK (share IN ('yes','no')),       -- whether the practice may discuss visits with the next of kin or carer; NULL = not asked
  last_test TEXT,                                 -- date of the last sight test, ISO
  recall_months INTEGER,
  next_exam TEXT,                                 -- the next exam Opticabase worked out, ISO; when set, the recall line comes from it
  ob_id TEXT,                                     -- the patient's Opticabase ID, so the two systems can be matched
  nhs_no TEXT,                                    -- NHS number: PCSE's pre-visit notification and the GOS6 claim need it
  premises TEXT,                                  -- where they're seen: home, residential, nursing, day (centre), sheltered; NULL = home
  venue TEXT,                                     -- the care home or day centre's name, so residents seen together are one visit
  venue_contact TEXT,                             -- who to ask for at the premises (PCSE's form asks for it)
  erased INTEGER NOT NULL DEFAULT 0,              -- personal details removed on request (the visit history stays, anonymised)
  tw TEXT, tw_at INTEGER                          -- a standing restriction on when they can be seen, copied onto new bookings
);
CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT, patient_id TEXT NOT NULL REFERENCES patients(id), label TEXT NOT NULL,
  body TEXT NOT NULL, author TEXT, created_at TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS appointments (
  id TEXT PRIMARY KEY, clinician_id TEXT NOT NULL REFERENCES clinicians(id), patient_id TEXT NOT NULL REFERENCES patients(id),
  type TEXT NOT NULL, day INTEGER NOT NULL DEFAULT 0, start_min INTEGER NOT NULL, drive INTEGER NOT NULL DEFAULT 10,
  status TEXT NOT NULL CHECK (status IN ('booked','enroute','live','done','missed','cancelled')), -- missed: nobody in when the clinician called
  moved INTEGER NOT NULL DEFAULT 0, seen INTEGER NOT NULL DEFAULT 0, note TEXT, reason TEXT, gap INTEGER NOT NULL DEFAULT 0,
  cancelled_min INTEGER, booked_min INTEGER, filled_from TEXT,
  reminded INTEGER NOT NULL DEFAULT 0,             -- day-before reminder sent
  source TEXT,                                     -- where the booking came from (domain SOURCES)
  reliability REAL,                                -- the office's own "true count" for this visit; NULL = the source's
  pvn_icb TEXT,                                    -- an NHS sight test inside PCSE's notice period: who at the ICB approved it
  pvn_early INTEGER NOT NULL DEFAULT 0,            -- booked as an early retest (before the recall line): the PVN needs a reason code
  ert TEXT,                                        -- that early retest code (PCSE's list: 1, 2, 3.1-3.3, 4.1, 4.2, 5.1-5.3, 6)
  cancel_token TEXT UNIQUE,                        -- secret for the family cancellation link (/cancel/<practice>/<token>)
  tw TEXT, tw_at INTEGER                           -- when the patient can be seen for this visit (domain TW); NULL = any time
);
CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY, number TEXT NOT NULL UNIQUE, appointment_id TEXT UNIQUE REFERENCES appointments(id),
  patient_id TEXT NOT NULL REFERENCES patients(id), items TEXT NOT NULL, total_pence INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'unpaid' CHECK (status IN ('unpaid','paid','void')), method TEXT,
  issued_at TEXT NOT NULL, issued_day INTEGER NOT NULL DEFAULT 0, paid_at TEXT
);
CREATE TABLE IF NOT EXISTS sales (               -- what the clinician sold at a visit (or why nothing was), one row per visit
  id INTEGER PRIMARY KEY AUTOINCREMENT, appointment_id TEXT NOT NULL UNIQUE REFERENCES appointments(id),
  patient_id TEXT NOT NULL, clinician_id TEXT NOT NULL, day INTEGER NOT NULL,  -- day: days from today, like appointments
  sold INTEGER NOT NULL DEFAULT 0,
  frames_pence INTEGER NOT NULL DEFAULT 0, frame_ref TEXT,      -- the frame: brand, model or code, as the clinician wrote it
  lenses_pence INTEGER NOT NULL DEFAULT 0, lens_desc TEXT,      -- the lenses: single vision, varifocals, coatings...
  total_pence INTEGER NOT NULL DEFAULT 0,
  voucher INTEGER NOT NULL DEFAULT 0,                           -- an NHS optical voucher (GOS3) goes towards it
  method TEXT,                                                  -- how it was paid: card (the practice's card reader)
  reason TEXT,                                                  -- nothing sold: why
  by_name TEXT NOT NULL, at TEXT NOT NULL,                      -- who recorded it, and when (YYYY-MM-DD HH:MM)
  copied_at TEXT, copied_by TEXT                                -- entered in Opticabase by the office
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
  created_at TEXT NOT NULL, done_by TEXT,
  ref TEXT                                         -- the PVN reference PCSE gave when it was lodged (the GOS6 claim needs it)
);
-- Referrals from the practice's website form: patients, family, carers, care homes, GPs. They replace the
-- documents and inbox the office used to retype from. Nothing is a patient until the office accepts it.
CREATE TABLE IF NOT EXISTS referrals (
  id TEXT PRIMARY KEY, created_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','accepted','declined')),
  from_kind TEXT NOT NULL, from_name TEXT, from_phone TEXT,
  name TEXT NOT NULL, dob TEXT, addr TEXT NOT NULL, pc TEXT NOT NULL, phone TEXT, eligibility TEXT NOT NULL,
  entitlement TEXT NOT NULL DEFAULT '[]', need TEXT NOT NULL, avail TEXT NOT NULL DEFAULT 'any', urgent INTEGER NOT NULL DEFAULT 0,
  notes TEXT, patient_id TEXT REFERENCES patients(id), decided_by TEXT, decline_reason TEXT
);
-- Leads from the practice's Facebook ads (or any ad form): someone asked to be called. Not a patient yet; the office
-- phones them and marks what happened. The thank-you email each one gets is kept in emails.
CREATE TABLE IF NOT EXISTS leads (
  id TEXT PRIMARY KEY, created_at TEXT NOT NULL, created_min INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','contacted','booked','closed')),
  source TEXT NOT NULL DEFAULT 'facebook', campaign TEXT, name TEXT NOT NULL, phone TEXT, email TEXT, pc TEXT,
  answers TEXT NOT NULL DEFAULT '[]', note TEXT, handled_by TEXT, handled_at TEXT, patient_id TEXT REFERENCES patients(id), meta_id TEXT,
  addr TEXT, dob TEXT,                             -- street address and date of birth, when the ad form asks for them
  pc_from TEXT                                     -- where the postcode came from: 'form', 'address' (found in it), or NULL (none yet)
);
CREATE TABLE IF NOT EXISTS emails (
  id INTEGER PRIMARY KEY AUTOINCREMENT, to_addr TEXT NOT NULL, to_name TEXT, subject TEXT NOT NULL, body TEXT NOT NULL,
  kind TEXT NOT NULL, lead_id TEXT, provider_id TEXT, created_at TEXT NOT NULL
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

/**
 * Columns added after a table was first made. A fresh database gets them from SCHEMA; a live practice's Postgres
 * tables, made with an older SCHEMA, get them added when the practice opens (pgstore.ensure). Each must be
 * nullable or have a default, so existing rows stay valid.
 */
const ADDED_COLUMNS = [
  ["patients", "recall_months", "BIGINT"],
  ["patients", "next_exam", "TEXT"],
  ["patients", "ob_id", "TEXT"],
  ["appointments", "source", "TEXT"],
  ["appointments", "reliability", "REAL"],
  ["users", "office", "BIGINT NOT NULL DEFAULT 0"],
  ["patients", "nhs_no", "TEXT"],
  ["patients", "premises", "TEXT"],
  ["patients", "venue", "TEXT"],
  ["patients", "venue_contact", "TEXT"],
  ["appointments", "pvn_icb", "TEXT"],
  ["appointments", "pvn_early", "BIGINT NOT NULL DEFAULT 0"],
  ["appointments", "ert", "TEXT"],
  ["pcse", "ref", "TEXT"],
  ["leads", "addr", "TEXT"],
  ["leads", "dob", "TEXT"],
  ["leads", "pc_from", "TEXT"],
  ["appointments", "tw", "TEXT"],
  ["appointments", "tw_at", "BIGINT"],
  ["patients", "tw", "TEXT"],
  ["patients", "tw_at", "BIGINT"],
];
const TABLES = ["audit", "emails", "leads", "pcse", "referrals", "messages", "offers", "notes", "invoices", "sales", "confirmations", "diary_log", "appointments", "recalls", "waitlist", "invites", "users", "patients", "clinicians"];

/** A fresh, seeded in-memory database for one sandbox, for its brand: the region and staff emails differ. */
function openDb(brand = brands.get(), { empty = false } = {}) {
  const d = new DatabaseSync(":memory:");
  d.exec("PRAGMA foreign_keys = ON;");
  d.exec(SCHEMA);
  if (!empty) seed(d, brand); // a live practice starts empty and is loaded from Postgres (server/pgstore.js)
  return d;
}
/** A demo user's sign-in email for this brand: sarah@<the brand's demo domain>. */
const emailFor = (u, brand = brands.get()) => `${brands.person(brand, u).local}@${brand.emailDomain}`;

/** An NHS number with a valid check digit (modulus 11), in the 999 range NHS England sets aside for testing. */
function testNhsNumber(i) {
  for (let k = 0; k < 20; k++) {
    const nine = String(999000000 + i * 131 + k).slice(0, 9).split("").map(Number);
    const c = 11 - (nine.reduce((t, d, j) => t + d * (10 - j), 0) % 11);
    if (c === 10) continue;
    return nine.join("") + (c === 11 ? 0 : c);
  }
  return null;
}
function seed(db, brand) {
  const region = brand.region;
  const ins = (table, row) => {
    const keys = Object.keys(row);
    db.prepare(`INSERT INTO ${table} (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`)
      .run(...keys.map((k) => (row[k] !== null && typeof row[k] === "object" ? JSON.stringify(row[k]) : row[k])));
  };
  db.exec("BEGIN");
  let clinicians = [
    { id: "c1", name: "Amira Shah", first: "Amira", role: "Optometrist", color: "#1E4D40", area_name: "North Leeds", patch: ["LS6", "LS16", "LS17"], near: ["LS7", "LS18", "LS8"], base: "LS6 4AA" },
    { id: "c2", name: "Tom Whitfield", first: "Tom", role: "Dispensing optician", color: "#3F6E8C", area_name: "East Leeds", patch: ["LS8", "LS9", "LS15"], near: ["LS7", "LS14", "LS26"], base: "LS8 2RS" },
    { id: "c3", name: "Priya Nair", first: "Priya", role: "Optometrist", color: "#7A5A8C", area_name: "South & West", patch: ["LS11", "LS12", "LS27"], near: ["LS13", "LS10", "LS28"], base: "LS12 3TL" },
  ];
  // Every demo gets its own two-factor secrets; the password is the shared demo one (hashed once at start-up).

  // rx: the last prescription, per eye: sphere, cylinder, axis, reading addition, and corrected acuity.
  const RX = (date, R, L) => ({ date, R: { sph: R[0], cyl: R[1], axis: R[2], add: R[3], va: R[4] }, L: { sph: L[0], cyl: L[1], axis: L[2], add: L[3], va: L[4] } });
  const P = (id, name, age, addr, pc, phone, o = {}) => ({ id, name, age, addr, pc, phone, contact: o.contact || "Text", alerts: o.alerts || [], specs: o.specs || "None on record", rx: o.rx || null, eligibility: o.eligibility || null, _h: o.h || [] });
  let patients = [
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
  // Later in the week, each clinician sees people from their own pool, starting from home.
  let pools = { c1: ["p20", "p21", "p22", "p23", "p24", "p2"], c2: ["p25", "p26", "p27", "p28", "p12", "p6"], c3: ["p29", "p30", "p31", "p10", "p14"] };
  let bases = { c1: "LS6 4AA", c2: "LS8 2RS", c3: "LS12 3TL" };
  let moreWaiting = [];
  let OPTOM_SLOTS = [[540, "sight"], [645, "dispense"], [780, "sight"], [900, "follow"]];
  let DISPENSER_SLOTS = [[540, "dispense"], [645, "repair"], [780, "dispense"], [900, "repair"]];
  if (region === "nw") ({ clinicians, patients, pools, bases, waitlist: moreWaiting, optomSlots: OPTOM_SLOTS, dispenserSlots: DISPENSER_SLOTS } = northWest(patients, P, travel.place));
  // A demo with its own team (server/brands.js) names the three clinicians itself.
  if (brand.people) clinicians = clinicians.map((c) => { const n = brand.people[c.id].name; return { ...c, name: n, first: n.split(" ")[0] }; });
  const ADMIN = brands.person(brand, USERS[0]).name;
  clinicians.forEach((r) => ins("clinicians", r));
  // The demo accounts: in the North West demo the clinicians' names and colours come from the seed.
  const clinOf = Object.fromEntries(clinicians.map((c) => [c.id, c]));
  USERS.forEach((u) => { const c = clinOf[u.clinicianId]; ins("users", { id: u.id, name: c ? c.name : brands.person(brand, u).name, role: u.role, clinician_id: u.clinicianId, email: emailFor(u, brand), pass_hash: auth.DEMO_HASH, totp_secret: auth.newSecret(), title: c ? c.role : u.title, color: c ? c.color : u.color }); });
  for (const p of patients) {
    const h = p._h || []; delete p._h;
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
  for (let day = 1; day <= 4; day++) {
    for (const [ci, cid] of ["c1", "c2", "c3"].entries()) {
      let prev = bases[cid];
      (cid === "c2" ? DISPENSER_SLOTS : OPTOM_SLOTS).forEach(([start, type], i, slots) => {
        if (i === (day + ci) % slots.length) return; // the free slot
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
    ...moreWaiting,
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
  // Referrals waiting for the office, as they'd arrive from the website overnight.
  const R = region === "nw"
    ? [["rf1", "family", "Karen Bolton-Hughes", "07700 900950", "Ada Greenhalgh", "1939-05-14", "7 Oak Avenue, Bolton", "BL3 6RT", "", "Dementia, can't go out without me", ["60+"], "sight", "am", 0, "Mum's glasses keep going missing and she's struggling to read the TV guide. Mornings are best, she's tired after lunch."],
       ["rf2", "carehome", "Moorside House (manager, Julie)", "07700 900951", "Thomas Ainscough", "1936-11-02", "Moorside House care home, Wigan", "WN6 7QA", "", "After a stroke, uses a wheelchair", ["60+", "benefits"], "sight", "any", 0, "New resident, last eye test unknown. Room 4."],
       ["rf3", "self", null, null, "Brenda Crossley", "1948-08-21", "19 Brook Street, Oldham", "OL4 2LP", "07700 900952", "Severe arthritis in my hips", ["60+", "glaucoma-family"], "sight", "pm", 1, "Sudden blurry patch in my left eye since yesterday."]]
    : [["rf1", "family", "Julie Fenton", "07700 900950", "Ada Greenhalgh", "1939-05-14", "7 Oak Avenue, Leeds", "LS16 8DE", "", "Dementia, can't go out without me", ["60+"], "sight", "am", 0, "Mum's glasses keep going missing. Mornings are best."],
       ["rf2", "carehome", "Moor Court (manager, Sue)", "07700 900951", "Thomas Ainscough", "1936-11-02", "Moor Court, Leeds", "LS17 7LH", "", "After a stroke, uses a wheelchair", ["60+", "benefits"], "sight", "any", 0, "New resident, room 4."],
       ["rf3", "self", null, null, "Brenda Crossley", "1948-08-21", "19 Brook Street, Leeds", "LS15 8BX", "07700 900952", "Severe arthritis in my hips", ["60+"], "repair", "pm", 0, "Arm snapped off my varifocals."]];
  R.forEach(([id, from_kind, from_name, from_phone, name, dob, addr, pc, phone, eligibility, entitlement, need, avail, urgent, notes], i) =>
    ins("referrals", { id, created_at: ["07:42", "08:15", "09:58"][i], from_kind, from_name, from_phone, name, dob, addr, pc, phone, eligibility, entitlement, need, avail, urgent, notes }));
  // Leads from the practice's Facebook ad overnight and this morning, each already sent the thank-you email.
  const AD = "Free NHS eye test at home";
  const LEADS = region === "nw"
    ? [["ld1", "08:12", 492, "new", "Joan Whittle", "07700 900960", "joan.whittle@example.com", "BL2 3AB", [["Who is the eye test for?", "My mum"], ["When did they last have an eye test?", "Over 2 years ago"]]],
       ["ld2", "09:31", 571, "new", "Derek Lord", "07700 900961", "derek.lord@example.com", "WN5 0JN", [["Who is the eye test for?", "Me"], ["When did they last have an eye test?", "I don't know"]]],
       ["ld3", "Yesterday 16:40", -440, "contacted", "Pauline Haworth", "07700 900962", "p.haworth@example.com", "BB2 4PL", [["Who is the eye test for?", "My dad"], ["When did they last have an eye test?", "1 to 2 years ago"]], "Left a voicemail at 9:15. Try again after 2pm."]]
    : [["ld1", "08:12", 492, "new", "Joan Whittle", "07700 900960", "joan.whittle@example.com", "LS16 7AB", [["Who is the eye test for?", "My mum"], ["When did they last have an eye test?", "Over 2 years ago"]]],
       ["ld2", "09:31", 571, "new", "Derek Lord", "07700 900961", "derek.lord@example.com", "LS17 6JN", [["Who is the eye test for?", "Me"], ["When did they last have an eye test?", "I don't know"]]],
       ["ld3", "Yesterday 16:40", -440, "contacted", "Pauline Haworth", "07700 900962", "p.haworth@example.com", "LS15 8PL", [["Who is the eye test for?", "My dad"], ["When did they last have an eye test?", "1 to 2 years ago"]], "Left a voicemail at 9:15. Try again after 2pm."]];
  // Home Visiting Optics use Opticabase: their sample patients carry an Opticabase ID, as their diary does.
  if (brand.id === "hvo") db.prepare("SELECT id FROM patients ORDER BY rowid").all().forEach((r, i) => db.prepare("UPDATE patients SET ob_id = ? WHERE id = ?").run(String(25180 + i * 7), r.id));
  // Where each sample booking came from, and a few the office doesn't trust to be in.
  const MIX = ["recall", "recall", "facebook", "recall", "old-recall", "referral", "recall", "new", "recall"];
  db.prepare("SELECT id FROM appointments ORDER BY id").all().forEach((r, i) => db.prepare("UPDATE appointments SET source = ? WHERE id = ?").run(MIX[i % MIX.length], r.id));
  db.prepare("UPDATE appointments SET reliability = 0.25 WHERE id IN ('a4', 'w2c30', 'w3c11')").run();
  LEADS.forEach(([id, created_at, created_min, status, name, phone, email, pc, answers, note]) => {
    ins("leads", { id, created_at, created_min, status, source: "facebook", campaign: AD, name, phone, email, pc, answers: JSON.stringify(answers), note: note || null, handled_by: note ? ADMIN : null, handled_at: note ? "09:15" : null });
    const subject = `Thank you for getting in touch with ${brand.practice}`;
    ins("emails", { to_addr: email, to_name: name, subject, body: leadEmail(name, brand.practice, brand.phone || null, brand.officeHours || "Monday to Friday, 9am to 5pm", brand.email || null), kind: "lead.thanks", lead_id: id, provider_id: "outbox-seed", created_at: created_at.replace(/^Yesterday /, "") });
  });
  // NHS sight tests already in the diary were notified to PCSE before the demo starts (they're kept off the
  // office's to-do list, which shows only what's left to do and what was done today).
  // Three residents of one nursing home, seen together in three weeks: one visit, so it needs 3 weeks' notice. And one
  // NHS test booked ten weeks out, too early for PCSE yet. Made-up people, like every sample patient.
  const homePc = pcOf[pools.c1[0]], home = { premises: "nursing", venue: "Moorside Court Nursing Home", venue_contact: "Duty manager, Moorside Court", addr: "2 Moor Lane", pc: homePc };
  [["p-mc1", "Edith Marsden", "1934-03-09", "2024-11-20"], ["p-mc2", "Walter Briggs", "1931-07-22", null], ["p-mc3", "Mabel Sutcliffe", "1938-12-01", "2025-01-15"]].forEach(([id, name, dob, last], i) => {
    ins("patients", { id, name, age: 2026 - Number(dob.slice(0, 4)), phone: "07700 900990", contact: "Call", alerts: JSON.stringify(["Ask for the duty manager at reception"]), specs: "Reading glasses", dob, last_test: last, eligibility: "Lives in a nursing home", ...home });
    ins("appointments", { id: `mc${i + 1}`, clinician_id: "c1", patient_id: id, type: "sight", day: 24, start_min: 600 + i * 60, status: "booked", drive: i ? 0 : 15 });
  });
  ins("appointments", { id: "lt1", clinician_id: "c3", patient_id: pools.c3[0], type: "sight", day: 71, start_min: 600, status: "booked", drive: 15 });
  // NHS sight tests already in the diary were notified before the demo starts, except those three, the one ten weeks
  // out, and one on Wednesday the office missed: inside its 48 hours, so the PCSE page flags it.
  const missed = (db.prepare("SELECT id FROM appointments WHERE type = 'sight' AND day = 2 ORDER BY id").get() || {}).id;
  db.prepare("SELECT * FROM appointments WHERE type = 'sight' AND status IN ('booked','enroute','live','done') ORDER BY id").all().forEach((a, i) => {
    const todo = a.id === missed || a.day > 14;
    ins("pcse", { action: "lodge", patient_id: a.patient_id, appointment_id: a.id, day: a.day, start_min: a.start_min, status: todo ? "todo" : "done", created_at: todo ? "09:05" : "", done_by: todo ? null : "Before the demo", ref: todo ? null : `PVN${4410200 + i * 37}` });
  });
  // NHS numbers for the sample patients (valid check digits, from the range set aside for testing: 999 000 0000+).
  db.prepare("SELECT id FROM patients ORDER BY rowid").all().forEach((r, i) => { const n = testNhsNumber(i); if (n) db.prepare("UPDATE patients SET nhs_no = ? WHERE id = ?").run(n, r.id); });
  // The last two weeks, so the reports have something to show: each clinician's usual round on each open day, most
  // visits done, a few cancelled or nobody in, and what was sold at them. Already copied into Opticabase.
  const cal = require("./calendar");
  const SOLD_AT = { sight: 2, dispense: 7, repair: 5 }; // one visit in n of each kind sells (sight tests most often)
  const WHY = ["Not needed", "Price", "Wants to think about it", "Has glasses already"];
  let h = 0;
  for (let day = -1; day >= -14 && brand.id === "hvo"; day--) { // the HVO demo only: the other demos start from today
    if (!cal.isOpen(day)) continue;
    for (const [ci, cid] of ["c1", "c2", "c3"].entries()) {
      let prev = bases[cid];
      (cid === "c2" ? DISPENSER_SLOTS : OPTOM_SLOTS).forEach(([start, type], i) => {
        const pool = pools[cid], pid = pool[(-day * 5 + i * 3 + ci) % pool.length], k = h++;
        const status = k % 11 === 3 ? "cancelled" : k % 17 === 5 ? "missed" : "done";
        const id = `h${-day}${cid}${i}`;
        ins("appointments", { id, clinician_id: cid, patient_id: pid, type, day, start_min: start, status, drive: driveMinutes(prev, pcOf[pid]) || 10, seen: status === "cancelled" ? 0 : 1,
          source: MIX[k % MIX.length], reason: status === "cancelled" ? ["Patient unwell", "Admitted to hospital", "Patient asked to rebook", "Carer or family can't be present"][k % 4] : null, cancelled_min: status === "cancelled" ? start - 900 : null });
        if (status === "cancelled" && k % 2) { // refilled from the call list: someone else seen in that slot
          const rp = pool[(-day * 7 + i + 11) % pool.length];
          ins("appointments", { id: id + "r", clinician_id: cid, patient_id: rp, type, day, start_min: start, status: "done", drive: driveMinutes(prev, pcOf[rp]) || 10, seen: 1, moved: 1, filled_from: id, booked_min: start - 870, source: "recall" });
        }
        if (status !== "cancelled") prev = pcOf[pid];
        if (status !== "done" || type === "follow") return;
        const at = `${cal.iso(day)} ${String(Math.floor(start / 60) + 1).padStart(2, "0")}:05`;
        const by = (clinOf[cid] || {}).name || "Clinician";
        if (k % (SOLD_AT[type] || 9) === 0) {
          const frames = [8900, 12900, 16500, 19900][k % 4], lenses = type === "repair" ? 0 : [4900, 9900, 17900, 22900][(k >> 1) % 4];
          ins("sales", { appointment_id: id, patient_id: pid, clinician_id: cid, day, sold: 1, frames_pence: frames, frame_ref: ["Silhouette 5529", "Ray-Ban RB5154", "Lindberg Air", "Own brand"][k % 4], lenses_pence: lenses,
            lens_desc: lenses ? ["Single vision", "Varifocals", "Varifocals, anti-glare", "Bifocals"][(k >> 1) % 4] : null, total_pence: frames + lenses, voucher: k % 3 === 0 ? 1 : 0, method: "card",
            by_name: by, at, copied_at: at, copied_by: "Sarah Lane" });
        } else ins("sales", { appointment_id: id, patient_id: pid, clinician_id: cid, day, sold: 0, reason: WHY[k % 4], by_name: by, at });
      });
    }
  }
  // Today so far: Amira sold glasses at her first visit (still to go into Opticabase).
  if (brand.id === "hvo") ins("sales", { appointment_id: "a1", patient_id: "p1", clinician_id: "c1", day: 0, sold: 1, frames_pence: 14900, frame_ref: "Silhouette 5529", lenses_pence: 17900, lens_desc: "Varifocals, anti-glare",
    total_pence: 32800, voucher: 0, method: "card", by_name: (clinOf.c1 || {}).name || "Amira Shah", at: `${cal.iso(0)} 10:02` });
  if (brand.id === "hvo") ins("sales", { appointment_id: "b1", patient_id: "p6", clinician_id: "c2", day: 0, sold: 0, reason: "Has glasses already", by_name: (clinOf.c2 || {}).name || "Tom Whitfield", at: `${cal.iso(0)} 09:58` });
  // Confirmation calls already made before the demo starts, so the diary's CC markers show a realistic mix: today's
  // visits had all three; tomorrow's have CC1 and CC2, and half their CC3; this week's mostly CC1, some CC2, a few
  // unanswered; later ones only some CC1. What's left is the Calls list's work for today.
  const STAFF = [ADMIN, ADMIN, (brand.people && brand.people.office2) || "Mo Patel"];
  const cc = (id, stage, outcome, at) => ins("confirmations", { appointment_id: id, stage, outcome, by_name: STAFF[(stage + id.length) % 3], at });
  db.prepare("SELECT a.id, a.day, p.contact FROM appointments a JOIN patients p ON p.id = a.patient_id WHERE a.status != 'cancelled' AND a.day BETWEEN 0 AND 21 ORDER BY a.day, a.id").all().forEach((a, i) => {
    const how = a.contact !== "Call" && i % 5 === 0 ? "texted" : "done";
    if (a.day === 0) { cc(a.id, 1, how, "Earlier"); cc(a.id, 2, "done", "Last week"); cc(a.id, 3, "done", "Yesterday"); return; }
    if (a.day === 1) { cc(a.id, 1, how, "Earlier"); cc(a.id, 2, "done", "Last week"); if (i % 2) cc(a.id, 3, "done", "Today 09:20"); return; }
    if (a.day <= 7) { cc(a.id, 1, how, "Earlier"); if (i % 3 === 0) cc(a.id, 2, "done", "Yesterday"); else if (i % 3 === 1) cc(a.id, 2, "no-answer", "Yesterday"); return; }
    if (i % 3) cc(a.id, 1, how, "Earlier");
  });
  // A demo for another kind of service: the same diary, in that sector's words (server/seed-sectors.js).
  require("./seed-sectors").flavour(db, sectors.get(brand.sector || process.env.SECTOR));
  ins("audit", { ts: "10:20:00", actor: "system", action: "seed", entity: "database", detail: "Demo data loaded" });
  db.exec("COMMIT");
}

sandbox.setOpener(openDb);

/** The email someone gets the moment their ad form arrives. Office hours come from the practice's settings. */
function leadEmail(name, practice, phone, hours, email) {
  const first = String(name).trim().split(/\s+/)[0];
  return `Hi ${first},\n\nThank you for your time. A member of our team will be in touch soon to talk about a home visit.\n\nOur office hours are ${hours}.${phone || email ? ` If you need us sooner, you can ${[phone && `call us on ${phone}`, email && `email ${email}`].filter(Boolean).join(" or ")}.` : ""}\n\nBest wishes,\n${practice}`;
}

// Row mappers: database shape → API shape
const J = (s, d) => { try { return s == null ? d : JSON.parse(s); } catch { return d; } };
const map = {
  clinician: (r) => ({ id: r.id, name: r.name, first: r.first, role: r.role, optom: r.role === sectors.current().roles.lead, /* has the sector's lead role */ color: r.color, areaName: r.area_name, patch: J(r.patch, []), near: J(r.near, []), base: r.base, hours: J(r.hours, DEFAULT_HOURS), active: r.active !== 0 }),
  user: (r) => ({ id: r.id, name: r.name, role: r.role, clinicianId: r.clinician_id, email: r.email, title: r.title, color: r.color, active: r.active !== 0, office: r.role === "admin" || !!r.office }),
  patient: (r) => ({ id: r.id, name: r.name, age: r.age, addr: r.addr, pc: r.pc, phone: r.phone, contact: r.contact, alerts: J(r.alerts, []), specs: r.specs, rx: J(r.rx, null), dob: r.dob, email: r.email, eligibility: r.eligibility, rep: r.rep, poa: r.poa, share: r.share, lastTest: r.last_test, recallMonths: r.recall_months || null, nextExam: r.next_exam || null, obId: r.ob_id || null, nhsNo: r.nhs_no || null, premises: r.premises || "home", venue: r.venue || null, venueContact: r.venue_contact || null, erased: !!r.erased , tw: r.tw ? { k: r.tw, at: r.tw_at } : null }),
  appt: (r) => ({ id: r.id, clinicianId: r.clinician_id, patientId: r.patient_id, type: r.type, day: r.day, start: r.start_min, drive: r.drive, status: r.status, moved: !!r.moved, seen: !!r.seen, note: r.note, reason: r.reason, gap: !!r.gap, cancelledMin: r.cancelled_min, bookedMin: r.booked_min, filledFrom: r.filled_from, reminded: !!r.reminded, pvnIcb: r.pvn_icb || null, ert: r.ert || null, pvnEarly: !!r.pvn_early, source: r.source || "new", reliability: r.reliability, count: r.reliability != null ? r.reliability : ((require("./domain").SOURCES[r.source] || require("./domain").SOURCES.new).count), tw: r.tw ? { k: r.tw, at: r.tw_at } : null }),
  wait: (r) => ({ id: r.id, patientId: r.patient_id, type: r.type, prio: r.prio, days: r.days, avail: r.avail, shortNotice: !!r.short_notice, prefClinicianId: r.pref_clinician_id, status: r.status, source: r.source || "list", note: r.note || null }),
  sale: (r) => ({ id: r.id, appointmentId: r.appointment_id, patientId: r.patient_id, clinicianId: r.clinician_id, day: r.day, sold: !!r.sold, framesPence: r.frames_pence, frameRef: r.frame_ref,
    lensesPence: r.lenses_pence, lensDesc: r.lens_desc, totalPence: r.total_pence, voucher: !!r.voucher, method: r.method, reason: r.reason, by: r.by_name, at: r.at, copiedAt: r.copied_at }),
  invoice: (r) => ({ id: r.id, number: r.number, appointmentId: r.appointment_id, patientId: r.patient_id, items: J(r.items, []), totalPence: r.total_pence, status: r.status, method: r.method, issuedAt: r.issued_at, issuedDay: r.issued_day, paidAt: r.paid_at }),
  recall: (r) => ({ id: r.id, patientId: r.patient_id, type: r.type, reason: r.reason, dueDay: r.due_day, status: r.status, waitlistId: r.waitlist_id, textedAt: r.texted_at }),
  msg: (r) => ({ id: r.id, dir: r.direction, name: r.to_name, phone: r.phone, body: r.body, kind: r.kind, toClin: r.to_clinician_id, fromClin: r.from_clinician_id, read: !!r.read, at: r.created_at, providerId: r.provider_id }),
  pcse: (r) => ({ id: r.id, action: r.action, patientId: r.patient_id, appointmentId: r.appointment_id, day: r.day, start: r.start_min, status: r.status, at: r.created_at, by: r.done_by, ref: r.ref || null }),
  referral: (r) => ({ id: r.id, at: r.created_at, status: r.status, fromKind: r.from_kind, fromName: r.from_name, fromPhone: r.from_phone, name: r.name, dob: r.dob, addr: r.addr, pc: r.pc, phone: r.phone, eligibility: r.eligibility, entitlement: J(r.entitlement, []), need: r.need, avail: r.avail, urgent: !!r.urgent, notes: r.notes, patientId: r.patient_id, decidedBy: r.decided_by, declineReason: r.decline_reason }),
  lead: (r) => ({ id: r.id, at: r.created_at, atMin: r.created_min, status: r.status, source: r.source, campaign: r.campaign, name: r.name, phone: r.phone, email: r.email, pc: r.pc, addr: r.addr || null, dob: r.dob || null, pcFrom: r.pc_from || (r.pc ? "form" : null), answers: J(r.answers, []), note: r.note, handledBy: r.handled_by, handledAt: r.handled_at, patientId: r.patient_id }),
  email: (r) => ({ id: r.id, to: r.to_addr, name: r.to_name, subject: r.subject, body: r.body, kind: r.kind, leadId: r.lead_id, at: r.created_at, providerId: r.provider_id }),
  note: (r) => ({ id: r.id, label: r.label, body: r.body, by: r.author, at: r.created_at }),
};

module.exports = { ADDED_COLUMNS, db, openDb, map, SCHEMA, TABLES, USERS, emailFor, DEFAULT_HOURS, leadEmail };
