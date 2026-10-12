"use strict";
// Builds the marketing website (site/) into a folder GitHub Pages can publish, with the app's own fonts and logo.
// Usage: node scripts/build-site.js [out-dir]
// Settings come from the environment (the Pages workflow passes them from the repository's Actions variables):
//   DEMO_URL  where "Try the demo" goes (the running app, e.g. on Render or Fly.io)
//   EMAIL     the contact address
//   SITE_URL  the site's own address, for link previews (optional; previews need absolute addresses)
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const out = path.resolve(root, process.argv[2] || "_site");
const cfg = {
  DEMO_URL: process.env.DEMO_URL || "https://app.domi.ysbdesigns.uk/?brand=domi", // the neutral demo, whatever brand the deployment defaults to
  EMAIL: process.env.EMAIL || "yameen@ysbdesigns.uk",
  SITE_URL: (process.env.SITE_URL || "https://domi.ysbdesigns.uk").replace(/\/$/, ""),
};
const esc = (t) => String(t).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

fs.rmSync(out, { recursive: true, force: true });
fs.cpSync(path.join(root, "site"), out, { recursive: true });
fs.mkdirSync(path.join(out, "fonts"));
for (const f of fs.readdirSync(path.join(root, "public", "fonts"))) {
  if (f.endsWith(".woff2")) fs.copyFileSync(path.join(root, "public", "fonts", f), path.join(out, "fonts", f));
}
for (const f of ["logo.svg", "favicon.svg"]) fs.copyFileSync(path.join(root, "public", f), path.join(out, f));

const title = "Domi · Home-visit diaries that refill themselves";
const description = "When a patient cancels, Domi texts the best-matched person on your waiting list, books the first yes and updates the clinician's phone.";
const social = [
  '<meta property="og:type" content="website">', '<meta property="og:site_name" content="Domi">',
  `<meta property="og:title" content="${esc(title)}">`, `<meta property="og:description" content="${esc(description)}">`,
  cfg.SITE_URL && `<link rel="canonical" href="${esc(cfg.SITE_URL)}/">`,
  cfg.SITE_URL && `<meta property="og:url" content="${esc(cfg.SITE_URL)}/">`,
  cfg.SITE_URL && `<meta property="og:image" content="${esc(cfg.SITE_URL)}/social.jpg">`,
  '<meta property="og:image:width" content="1200">', '<meta property="og:image:height" content="630">',
  '<meta name="twitter:card" content="summary_large_image">',
].filter(Boolean).join("\n");

const file = path.join(out, "index.html");
let html = fs.readFileSync(file, "utf8").replace("<!--SOCIAL-->", social);
for (const [k, v] of Object.entries(cfg)) html = html.split(`%%${k}%%`).join(esc(v));
const left = html.match(/%%[A-Z_]+%%/);
if (left) throw new Error(`site/index.html uses ${left[0]}, which build-site.js doesn't fill in`);
fs.writeFileSync(file, html);
fs.writeFileSync(path.join(out, ".nojekyll"), "");
console.log(`Built ${path.relative(root, out)}/ (demo: ${cfg.DEMO_URL})`);
