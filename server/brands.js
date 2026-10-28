"use strict";
// How a demo looks and where it is. The default is Domi's own invented practice in Leeds. A practice we're
// showing Domi to can have its own: their name, colours, typeface and logo, their towns, and a sample diary
// set there. It's opened with a private link (/?brand=<id>), never shown by default, so a practice's
// branding appears only to the people we send that link to.
//
// Logos stay on the practice's own website: the page loads them from there rather than this repository
// keeping a copy of someone else's trademark.

const BRANDS = {
  domi: {
    id: "domi", practice: "Aire Valley Eyecare", region: "leeds", emailDomain: "airevalleyeyecare.example",
    logo: null, wordmark: "Domi", tagline: "Eye care at home",
  },
  // Demos for the other kinds of home-visit service: invented practices in Leeds, each with its own team, sample
  // patients and its sector's visits and roles (server/sectors.js, server/seed-sectors.js). Opened with /?brand=<id>.
  // people: the office manager (admin), a second office member who makes calls (office2), and the three clinicians
  // (c1 and c3 have the lead role, c2 the support role). Their sign-in emails are their first names at emailDomain.
  hearing: {
    id: "hearing", sector: "audiology", practice: "Larkfell Hearing at Home", region: "leeds", emailDomain: "larkfellhearing.example",
    logo: null, wordmark: "Domi", tagline: "Hearing care at home",
    people: { admin: { name: "Rachel Holmes" }, office2: "Gary Senior", c1: { name: "Daniel Okafor" }, c2: { name: "Chloe Barker" }, c3: { name: "Imran Hussain" } },
  },
  podiatry: {
    id: "podiatry", sector: "podiatry", practice: "Pennick Foot Care", region: "leeds", emailDomain: "pennickfootcare.example",
    logo: null, wordmark: "Domi", tagline: "Foot care at home",
    people: { admin: { name: "Karen Mitchell" }, office2: "Dawn Fletcher", c1: { name: "Hannah Lees" }, c2: { name: "Jordan Pearce" }, c3: { name: "Sanjay Patel" } },
  },
  physio: {
    id: "physio", sector: "physio", practice: "Ravensholt Home Physio", region: "leeds", emailDomain: "ravensholtphysio.example",
    logo: null, wordmark: "Domi", tagline: "Physiotherapy at home",
    people: { admin: { name: "Lisa Booth" }, office2: "Craig Dyson", c1: { name: "Ben Carter" }, c2: { name: "Megan Wood" }, c3: { name: "Aisha Rahman" } },
  },
  dental: {
    id: "dental", sector: "dental", practice: "Hollowmere Dental at Home", region: "leeds", emailDomain: "hollowmeredental.example",
    logo: null, wordmark: "Domi", tagline: "Dental care at home",
    people: { admin: { name: "Nicola Webb" }, office2: "Steph Ingham", c1: { name: "Omar Siddiqui" }, c2: { name: "Ellie Shaw" }, c3: { name: "Rebecca Hall" } },
  },
  nursing: {
    id: "nursing", sector: "nursing", practice: "Fellwick Home Nursing", region: "leeds", emailDomain: "fellwicknursing.example",
    logo: null, wordmark: "Domi", tagline: "Nursing care at home",
    people: { admin: { name: "Joanne Firth" }, office2: "Paul Haigh", c1: { name: "Grace Adeyemi" }, c2: { name: "Liam Hartley" }, c3: { name: "Fiona Grant" } },
  },
  ot: {
    id: "ot", sector: "ot", practice: "Sablewood Home OT", region: "leeds", emailDomain: "sablewoodot.example",
    logo: null, wordmark: "Domi", tagline: "Occupational therapy at home",
    people: { admin: { name: "Claire Dixon" }, office2: "Mark Ashworth", c1: { name: "Natalie Moss" }, c2: { name: "Kyle Jennings" }, c3: { name: "Zara Ali" } },
  },
  hvo: {
    id: "hvo", practice: "Home Visiting Optics", region: "nw", emailDomain: "homevisitingoptics.example",
    // Their own logo, served from their own site. If it can't load, the name is shown instead.
    logo: "https://www.homevisitingoptics.co.uk/images/logo.png", logoAlt: "Home Visiting Optician",
    wordmark: "Home Visiting Optics", tagline: "Quality vision care wherever you are",
    // From their website: Outfit throughout, a bright blue, a navy bar, white pages, pill-shaped buttons.
    theme: { font: "Outfit", primary: "#0089CF", navy: "#0B3B7C", ink: "#041223" },
    // Contact details and opening hours, from their website's contact page.
    phone: "01204 292 005", mobile: "07813 792 478", email: "info@homevisitingoptics.co.uk", website: "https://www.homevisitingoptics.co.uk/",
    officeHours: "Monday to Friday, 9am to 5.30pm",
  },
};

// A deployment can open in a practice's brand by default (DEFAULT_BRAND=<id>), so the plain address shows it;
// /?brand=domi still gives the neutral demo, which is what the marketing site links to.
// Where "Powered by Domi" links to, at the foot of a practice's branded demo.
const SITE = process.env.MARKETING_URL || "https://domi.ysbdesigns.uk/";
const get = (id) => BRANDS[String(id || "").toLowerCase()] || BRANDS[String(process.env.DEFAULT_BRAND || "").toLowerCase()] || BRANDS.domi;
/** What the browser may know about a brand (everything here is already public on the practice's website). */
const pub = (b) => ({ id: b.id, sector: b.sector || null, practice: b.practice, logo: b.logo, logoAlt: b.logoAlt || b.practice, wordmark: b.wordmark, tagline: b.tagline, theme: b.theme || null, phone: b.phone || null, mobile: b.mobile || null, email: b.email || null, website: b.website || null, site: SITE });

/** A demo account's person in this brand: the brand's own team where it has one, else the default demo's. */
function person(brand, u) {
  const p = brand.people && brand.people[u.clinicianId || "admin"];
  return p ? { name: p.name, local: p.name.split(" ")[0].toLowerCase() } : { name: u.name, local: u.email.replace(/@.*/, "") };
}

module.exports = { BRANDS, get, pub, person };
