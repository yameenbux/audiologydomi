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
  hvo: {
    id: "hvo", practice: "Home Visiting Optics", region: "nw", emailDomain: "homevisitingoptics.example",
    // Their own logo, served from their own site. If it can't load, the name is shown instead.
    logo: "https://www.homevisitingoptics.co.uk/images/logo.png", logoAlt: "Home Visiting Optician",
    wordmark: "Home Visiting Optics", tagline: "Quality vision care wherever you are",
    // From their website: Outfit throughout, a bright blue, a navy bar, white pages, pill-shaped buttons.
    theme: { font: "Outfit", primary: "#0089CF", navy: "#0B3B7C", ink: "#041223" },
    phone: "01204 292 005",
  },
};

const get = (id) => BRANDS[String(id || "").toLowerCase()] || BRANDS.domi;
/** What the browser may know about a brand (everything here is already public on the practice's website). */
const pub = (b) => ({ id: b.id, practice: b.practice, logo: b.logo, logoAlt: b.logoAlt || b.practice, wordmark: b.wordmark, tagline: b.tagline, theme: b.theme || null, phone: b.phone || null });

module.exports = { BRANDS, get, pub };
