"use strict";
// The North West demo: the same invented diary as the Leeds one (same people, same story), moved to the
// towns Home Visiting Optics covers, plus 18 more invented patients so there are 50 in all.
//
// Everything here is made up: names, addresses, postcodes and phone numbers. The phone numbers are in
// Ofcom's 07700 900xxx range, which is reserved for drama and never issued. The postcodes are invented
// too, so each one is pinned near its district's centre (travel.place) instead of being looked up.
const { REGIONS } = require("./regions");

const CENTRE = Object.fromEntries(REGIONS.nw.towns.flatMap((t) => Object.entries(t.districts).map(([d, c]) => [d, { town: t.town, c }])));

// A small seeded random generator, so every demo gets exactly the same addresses.
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
const hash = (str) => [...str].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7);
const LETTERS = "ABDEFGHJLNPQRSTUWXYZ";
const STREETS = ["Ash Grove", "Holly Bank", "Moorside Road", "Church Lane", "Kingsway", "Park View", "Station Road", "Vicarage Close", "Mill Lane", "Elm Street",
  "Rose Avenue", "Hawthorn Drive", "Brook Street", "Chapel Walk", "Meadow Way", "Oak Avenue", "Sunnyside Road", "Willow Court", "Green Lane", "Victoria Terrace"];

/** An invented postcode in this district and a spot within about a kilometre of its centre. */
function placeIn(district, key) {
  const r = rng(hash(key));
  const pc = `${district} ${1 + Math.floor(r() * 9)}${LETTERS[Math.floor(r() * LETTERS.length)]}${LETTERS[Math.floor(r() * LETTERS.length)]}`;
  const [lat, lon] = CENTRE[district].c;
  return { pc, coords: [+(lat + (r() - 0.5) * 0.016).toFixed(5), +(lon + (r() - 0.5) * 0.026).toFixed(5)], street: `${2 + Math.floor(r() * 88)} ${STREETS[Math.floor(r() * STREETS.length)]}`, town: CENTRE[district].town };
}

// Where each of the Leeds demo's patients lives in the North West version. The first visits of the day
// keep each clinician's round together: Amira around Bolton and Bury, Tom around Wigan and Warrington
// (he also covers the coast), Priya around Manchester and Oldham.
const HOMES = {
  p1: "BL1", p2: "BL1", p3: "BL2", p4: "BL3", p5: "BL1", p6: "WN1", p7: "WN3", p8: "BL1", p9: "BL6", p10: "M20", p11: "OL1", p12: "WN2", p13: "BL3", p14: "M21", p15: "WN6", p16: "BL2",
  p20: "BL1", p21: "BL7", p22: "BL8", p23: "BB1", p24: "BL3", p25: "WN1", p26: "WA1", p27: "WA4", p28: "FY2", p29: "M9", p30: "OL4", p31: "OL8",
  p40: "BL5", p41: "BL9", p42: "WN5", p43: "M14",
};
// Some addresses are a flat or a care home in the Leeds story; they stay that way here.
const KEEP_PLACE = { p3: "Flat 4, Moor Court", p22: "Flat 2, Rose Court", p24: "Ryecroft Care Home" };

// The 18 more patients. [id, name, age, district, extras]
const MORE = [
  ["p50", "Elsie Haworth", 89, "BB2", { eligibility: "Dementia", specs: "Varifocals", alerts: ["Daughter Karen present for visits"] }],
  ["p51", "Reginald Tattersall", 84, "BB3", { eligibility: "Severe arthritis in both knees", specs: "Bifocals" }],
  ["p52", "Winifred Pye", 91, "FY1", { eligibility: "Housebound after a hip fracture", specs: "Reading glasses", alerts: ["Key safe by the back door"] }],
  ["p53", "Ernest Cartmell", 80, "FY3", { eligibility: "COPD, on home oxygen", specs: "Varifocals", contact: "Call" }],
  ["p54", "Lilian Gaskell", 86, "FY4", { eligibility: "Parkinson's disease", specs: "Single vision distance" }],
  ["p55", "Harold Entwistle", 77, "BL9", { eligibility: "After a stroke, uses a frame", specs: "Varifocals" }],
  ["p56", "Beryl Scowcroft", 93, "BL4", { eligibility: "Dementia", specs: "Bifocals", alerts: ["Lives with son Gary"] }],
  ["p57", "Cyril Fairclough", 82, "BL5", { eligibility: "Heart failure, breathless walking", specs: "Varifocals" }],
  ["p58", "Gladys Ormerod", 88, "M19", { eligibility: "Registered partially sighted, agoraphobia", specs: "Magnifier and reading glasses", contact: "Call", alerts: ["Partially sighted: phone, don't text"] }],
  ["p59", "Wilfred Ashcroft", 79, "M8", { eligibility: "Multiple sclerosis", specs: "Varifocals" }],
  ["p60", "Ivy Brindle", 90, "M14", { eligibility: "Frailty after a long hospital stay", specs: "Reading glasses" }],
  ["p61", "Leonard Hulme", 85, "M40", { eligibility: "Severe COPD", specs: "Bifocals" }],
  ["p62", "Hilda Schofield", 83, "OL2", { eligibility: "Vertigo, falls at home", specs: "Varifocals", alerts: ["Carer visits 9:00–9:30"] }],
  ["p63", "Albert Kenyon", 87, "WN7", { eligibility: "Dementia", specs: "Varifocals", alerts: ["Wife Jean answers door"] }],
  ["p64", "Marjorie Lowe", 81, "OL9", { eligibility: "Rheumatoid arthritis", specs: "Single vision reading" }],
  ["p65", "Stanley Pennington", 92, "WA2", { eligibility: "Bedbound after a stroke", specs: "Bifocals" }],
  ["p66", "Freda Livesey", 78, "WA5", { eligibility: "Agoraphobia, diagnosed", specs: "Varifocals" }],
  ["p67", "Norman Unsworth", 84, "WN4", { eligibility: "Parkinson's disease", specs: "Varifocals" }],
];
// Every Leeds patient also gets a condition, so the home-visit reason is filled in across the demo.
const CONDITIONS = ["Dementia", "Severe arthritis", "Parkinson's disease", "COPD, on home oxygen", "After a stroke", "Frailty, falls risk", "Heart failure", "Multiple sclerosis", "Vertigo", "Agoraphobia, diagnosed"];

const CLINICIANS = [
  { id: "c1", name: "Amira Shah", first: "Amira", role: "Optometrist", color: "#0B3B7C", area_name: "Bolton, Bury & Lancashire",
    patch: ["BL1", "BL2", "BL3", "BL4", "BL5", "BL6", "BL7", "BL8", "BL9"], near: ["BB1", "BB2", "BB3", "FY1", "FY2", "FY3", "FY4", "WN1", "WN6", "M8", "OL9"], base: "BL1 5DN" },
  { id: "c2", name: "Tom Whitfield", first: "Tom", role: "Dispensing optician", color: "#0089CF", area_name: "Wigan, Warrington & the coast",
    patch: ["WN1", "WN2", "WN3", "WN4", "WN5", "WN6", "WN7", "WA1", "WA2", "WA3", "WA4", "WA5", "FY1", "FY2", "FY3", "FY4"], near: ["BL3", "BL5", "BL6", "BB1", "BB2", "BB3", "M8", "M40"], base: "WN1 2PL" },
  { id: "c3", name: "Priya Nair", first: "Priya", role: "Optometrist", color: "#6C4FA0", area_name: "Manchester & Oldham",
    patch: ["M8", "M9", "M11", "M12", "M13", "M14", "M16", "M18", "M19", "M20", "M21", "M22", "M23", "M40", "OL1", "OL2", "OL4", "OL8", "OL9"], near: ["BL2", "BL4", "BL9", "WA3", "WA1"], base: "M20 6QR" },
];
// Clinicians start from home: an invented point in their base district.
const BASES = { "BL1 5DN": "BL1", "WN1 2PL": "WN1", "M20 6QR": "M20" };

/**
 * Turn the Leeds sample patients into North West ones and add the 18 more. `place(pc, coords)` pins each
 * invented postcode for the drive times. Returns what db.js seeds with.
 */
function northWest(patients, P, place) {
  // The overnight referrals (db.js) have invented postcodes too.
  [["BL3 6RT", "BL3"], ["WN6 7QA", "WN6"], ["OL4 2LP", "OL4"]].forEach(([pc, d]) => place(pc, placeIn(d, "ref" + pc).coords));
  for (const [pc, d] of Object.entries(BASES)) place(pc, placeIn(d, "base" + pc).coords);
  const out = patients.map((p, i) => {
    const d = HOMES[p.id]; if (!d) return p;
    const h = placeIn(d, p.id);
    place(h.pc, h.coords);
    const addr = KEEP_PLACE[p.id] ? `${KEEP_PLACE[p.id]}, ${h.town}` : `${h.street}, ${h.town}`;
    return { ...p, addr, pc: h.pc, eligibility: CONDITIONS[i % CONDITIONS.length] };
  });
  for (const [id, name, age, d, o] of MORE) {
    const h = placeIn(d, id);
    place(h.pc, h.coords);
    const phone = `07700 900${String(500 + Number(id.slice(1))).padStart(3, "0")}`;
    out.push({ ...P(id, name, age, `${h.street}, ${h.town}`, h.pc, phone, o), eligibility: o.eligibility });
  }
  return {
    clinicians: CLINICIANS,
    patients: out,
    pools: { c1: ["p20", "p21", "p22", "p23", "p24", "p2", "p50", "p51", "p55", "p56", "p57"], c2: ["p25", "p26", "p27", "p28", "p12", "p6", "p52", "p53", "p54", "p63", "p65", "p66", "p67"], c3: ["p29", "p30", "p31", "p10", "p14", "p59", "p60", "p61", "p62", "p64"] },
    bases: { c1: "BL1 5DN", c2: "WN1 2PL", c3: "M20 6QR" },
    // A fuller week than the Leeds demo: an optometrist's day is six eye-care slots, a dispensing optician's
    // eight deliveries and repairs, with one left free each day for bookings and refills.
    optomSlots: [[540, "sight"], [620, "dispense"], [670, "sight"], [780, "sight"], [860, "follow"], [910, "sight"]],
    dispenserSlots: [[540, "dispense"], [590, "repair"], [630, "dispense"], [680, "repair"], [780, "dispense"], [830, "dispense"], [880, "repair"], [920, "dispense"]],
    // More people waiting, across the towns.
    waitlist: [
      { id: "w7", patient_id: "p52", type: "dispense", prio: "routine", days: 8, avail: "any", short_notice: 1, pref_clinician_id: "c2" },
      { id: "w8", patient_id: "p58", type: "sight", prio: "soon", days: 5, avail: "am", short_notice: 1, pref_clinician_id: null },
      { id: "w9", patient_id: "p63", type: "repair", prio: "routine", days: 11, avail: "any", short_notice: 1, pref_clinician_id: null },
      { id: "w10", patient_id: "p55", type: "follow", prio: "routine", days: 17, avail: "any", short_notice: 1, pref_clinician_id: "c1" },
    ],
  };
}

module.exports = { northWest, placeIn };
