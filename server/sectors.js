"use strict";
// What changes from one kind of home-visit service to another. Everything else in Domi (the diary, refilling
// cancellations, route planning, reminders, recalls, leads, mileage, reports) is the same engine for all of them.
//
// Each practice has one sector (its `sector` setting, from its brand, or SECTOR on a live server); a practice
// without one is a domiciliary optician, which is what Home Visiting Optics has always been.
//
// Visit types are five fixed slots, the same keys in every sector, so a practice's records, settings and the
// engine's own defaults never depend on the sector:
//   sight     the main visit a lead clinician does; usually what recalls are for
//   exam      a second lead-only visit
//   dispense  a longer visit anyone on the team can do
//   repair    a short visit anyone on the team can do
//   follow    a follow-up or review
// The keys keep their eye-care names because live practices' records already use them.
//
// Each team has a lead role (who can do every visit) and a support role (who can do the visits that aren't marked
// lead). A clinician's `optom` flag means "has the lead role", whatever the sector calls it.
//
// Modules switch whole features on or off: pcse (NHS sight-test notifications and the recall line, opticians in
// England only), sales (frames and lenses sold at the visit), importFrom (the practice system an import and the
// "copy to" list are named after), prescription (the eye prescription on a record).

const SECTORS = {
  optical: {
    id: "optical", name: "Domiciliary eye care", field: "eye care", trade: "optician", hero: "Eye care that <em>comes to you.</em>",
    roles: { lead: "Optometrist", support: "Dispensing optician", leadPlural: "optometrists", supportDoes: "dispenses" },
    types: {
      sight: { name: "NHS sight test", dur: 60, lead: true, pvn: true },
      exam: { name: "Private eye examination", dur: 60, lead: true },
      dispense: { name: "Glasses delivery & fitting", dur: 30 },
      repair: { name: "Repair & adjustment", dur: 20 },
      follow: { name: "Follow-up check", dur: 30, lead: true },
    },
    // In pounds. 0 = no invoice: NHS sight tests are claimed on a GOS 6, glasses are charged when ordered.
    prices: { sight: 0, exam: 65, dispense: 0, repair: 15, follow: 35 },
    online: ["sight", "exam", "repair", "follow"],
    fee: 85, // what an empty slot is worth, for the pilot results
    recall: { type: "sight", what: "sight test", months: 24 }, // NHS rules: yearly from 70 (server/importer.js)
    modules: { pcse: true, sales: true, prescription: true, importFrom: "Opticabase" },
    fields: { kit: "Glasses", kitHint: "e.g. Varifocals", kitNone: "None on record", last: "Last sight test", why: "can't get to an optician's without help" },
    refer: { sight: "An eye test", dispense: "New glasses fitted", repair: "A glasses repair or adjustment", follow: "A recheck" },
    // Who can have a free NHS sight test; asked on the referral form.
    entitlement: { "60+": "Aged 60 or over", benefits: "Receives a qualifying benefit", diabetes: "Has diabetes", glaucoma: "Has glaucoma", "glaucoma-family": "40+ with glaucoma in the family", sight: "Registered partially sighted or blind", hc2: "HC2 certificate" },
    urgent: "Sight has changed suddenly",
    outcomes: ["Vision recorded", "Pressures checked", "Fundus photos taken", "Frames chosen", "GOS 6 signed", "Glasses fitted & adjusted", "Referred to GP"],
    noSale: ["Not needed", "Price", "Wants to think about it", "Has glasses already"],
  },

  audiology: {
    id: "audiology", name: "Home hearing care", field: "hearing care", trade: "audiologist", hero: "Hearing care that <em>comes to you.</em>",
    roles: { lead: "Audiologist", support: "Hearing care assistant", leadPlural: "audiologists", supportDoes: "does follow-ups and repairs" },
    types: {
      sight: { name: "Hearing assessment", dur: 60, lead: true },
      exam: { name: "Hearing aid fitting", dur: 60, lead: true },
      dispense: { name: "Hearing aid follow-up", dur: 30 },
      repair: { name: "Hearing aid repair & retube", dur: 20 },
      follow: { name: "Ear wax removal", dur: 30, lead: true },
    },
    prices: { sight: 0, exam: 0, dispense: 0, repair: 15, follow: 60 },
    online: ["sight", "repair", "follow"],
    fee: 60,
    recall: { type: "sight", what: "hearing check", months: 12 },
    modules: { pcse: false, sales: false, prescription: false, importFrom: null },
    fields: { kit: "Hearing aids", kitHint: "e.g. Both ears, behind the ear", kitNone: "None", last: "Last hearing test", why: "can't get to a hearing centre without help" },
    refer: { sight: "A hearing test", exam: "Hearing aids fitted", repair: "A hearing aid repair", follow: "Ear wax removal" },
    entitlement: null,
    urgent: "Hearing has changed suddenly",
    outcomes: ["Otoscopy done", "Audiogram recorded", "Wax removed", "Aids fitted & programmed", "Tubes replaced", "Referred to GP"],
    noSale: null,
  },

  podiatry: {
    id: "podiatry", name: "Home podiatry", field: "foot care", trade: "podiatrist", hero: "Foot care that <em>comes to you.</em>",
    roles: { lead: "Podiatrist", support: "Foot health practitioner", leadPlural: "podiatrists", supportDoes: "does routine nail care" },
    types: {
      sight: { name: "Podiatry assessment", dur: 45, lead: true },
      exam: { name: "Diabetic foot check", dur: 30, lead: true },
      dispense: { name: "Routine nail care", dur: 30 },
      repair: { name: "Corn & callus care", dur: 30 },
      follow: { name: "Wound review", dur: 30, lead: true },
    },
    prices: { sight: 55, exam: 45, dispense: 38, repair: 38, follow: 40 },
    online: ["sight", "dispense", "repair"],
    fee: 40,
    // Most patients are seen for nail care every 6 to 8 weeks: that's what the recall texts are for.
    recall: { type: "dispense", what: "nail care visit", months: 2 },
    modules: { pcse: false, sales: false, prescription: false, importFrom: null },
    fields: { kit: "Footwear and insoles", kitHint: "e.g. Orthotic insoles", kitNone: "None noted", last: "Last foot check", why: "can't get to a clinic without help" },
    refer: { sight: "A foot assessment", exam: "A diabetic foot check", dispense: "Nail care", follow: "A wound or ulcer review" },
    entitlement: null,
    urgent: "A wound, ulcer or sudden pain",
    outcomes: ["Nails cut & filed", "Corns or callus treated", "Pulses checked", "Sensation tested", "Dressing applied", "Referred to GP"],
    noSale: null,
  },

  physio: {
    id: "physio", name: "Home physiotherapy", field: "physiotherapy", trade: "physiotherapist", hero: "Physiotherapy that <em>comes to you.</em>",
    roles: { lead: "Physiotherapist", support: "Rehab assistant", leadPlural: "physiotherapists", supportDoes: "runs exercise sessions" },
    types: {
      sight: { name: "Initial assessment", dur: 60, lead: true },
      exam: { name: "Neuro physio session", dur: 60, lead: true },
      dispense: { name: "Exercise & rehab session", dur: 45 },
      repair: { name: "Equipment check", dur: 30 },
      follow: { name: "Progress review", dur: 45, lead: true },
    },
    prices: { sight: 90, exam: 80, dispense: 55, repair: 40, follow: 70 },
    online: ["sight", "follow"],
    fee: 70,
    recall: { type: "follow", what: "progress review", months: 3 },
    modules: { pcse: false, sales: false, prescription: false, importFrom: null },
    fields: { kit: "Mobility aids", kitHint: "e.g. Zimmer frame, perching stool", kitNone: "None", last: "Last assessment", why: "can't get to a clinic without help" },
    refer: { sight: "A physio assessment", exam: "Neuro physio", dispense: "Exercise and rehab sessions", follow: "A progress review" },
    entitlement: null,
    urgent: "A recent fall or a sudden change",
    outcomes: ["Assessment recorded", "Exercises taught", "Exercise sheet left", "Walking aid checked", "Goals reviewed", "Referred to GP"],
    noSale: null,
  },

  nursing: {
    id: "nursing", name: "Home nursing", field: "nursing", trade: "nurse", hero: "Nursing care that <em>comes to you.</em>",
    roles: { lead: "Nurse", support: "Healthcare assistant", leadPlural: "nurses", supportDoes: "takes bloods and observations" },
    types: {
      sight: { name: "Nurse assessment", dur: 45, lead: true },
      exam: { name: "Wound dressing", dur: 30, lead: true },
      dispense: { name: "Blood test", dur: 15 },
      repair: { name: "Blood pressure & observations", dur: 20 },
      follow: { name: "Injection", dur: 15, lead: true },
    },
    prices: { sight: 75, exam: 50, dispense: 45, repair: 35, follow: 45 },
    online: ["dispense", "repair", "follow"],
    fee: 45,
    recall: { type: "dispense", what: "blood test", months: 3 },
    modules: { pcse: false, sales: false, prescription: false, importFrom: null },
    fields: { kit: "Medication and allergies", kitHint: "e.g. Warfarin, allergic to plasters", kitNone: "None noted", last: "Last visit", why: "can't get to a clinic without help" },
    refer: { sight: "A nurse assessment", exam: "Wound care", dispense: "A blood test", follow: "An injection" },
    entitlement: null,
    urgent: "Unwell now or a wound getting worse",
    outcomes: ["Observations recorded", "Bloods taken", "Dressing changed", "Injection given", "Samples sent to lab", "Referred to GP"],
    noSale: null,
  },
};

const DEFAULT = "optical";
const KEYS = ["sight", "exam", "dispense", "repair", "follow"];

/** A sector by id; an unknown or missing one is the default (opticians). */
const get = (id) => SECTORS[String(id || "").toLowerCase()] || SECTORS[DEFAULT];

/** The sector of the practice in context: the request's practice, else the server's SECTOR, else opticians. */
function current() {
  let sb = null;
  try { sb = require("./sandbox").current(); } catch { /* not inside a practice */ }
  return get((sb && sb.settings && sb.settings.sector) || (sb && sb.brand && sb.brand.sector) || process.env.SECTOR);
}

/** "an audiologist", "a podiatrist". */
const an = (w) => `${/^[aeiou]/i.test(w) ? "an" : "a"} ${w}`;

/** What the browser needs to word and lay out screens for this sector. */
const view = (s = current()) => {
  const { types, prices, online, fee, ...rest } = s;
  return rest;
};

module.exports = { SECTORS, KEYS, DEFAULT, get, current, view, an };
