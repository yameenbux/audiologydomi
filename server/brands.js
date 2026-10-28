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
  // Demos for the other kinds of home-visit service: invented practices in Leeds, each with its sector's visits,
  // roles and sample patients (server/sectors.js, server/seed-sectors.js). Opened with /?brand=<id>.
  hearing: {
    id: "hearing", sector: "audiology", practice: "Kestrel Hearing at Home", region: "leeds", emailDomain: "kestrelhearing.example",
    logo: null, wordmark: "Domi", tagline: "Hearing care at home",
  },
  podiatry: {
    id: "podiatry", sector: "podiatry", practice: "Kestrel Foot Care", region: "leeds", emailDomain: "kestrelfootcare.example",
    logo: null, wordmark: "Domi", tagline: "Foot care at home",
  },
  physio: {
    id: "physio", sector: "physio", practice: "Kestrel Home Physio", region: "leeds", emailDomain: "kestrelphysio.example",
    logo: null, wordmark: "Domi", tagline: "Physiotherapy at home",
  },
  dental: {
    id: "dental", sector: "dental", practice: "Kestrel Dental at Home", region: "leeds", emailDomain: "kestreldental.example",
    logo: null, wordmark: "Domi", tagline: "Dental care at home",
  },
  nursing: {
    id: "nursing", sector: "nursing", practice: "Kestrel Home Nursing", region: "leeds", emailDomain: "kestrelnursing.example",
    logo: null, wordmark: "Domi", tagline: "Nursing care at home",
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

module.exports = { BRANDS, get, pub };
