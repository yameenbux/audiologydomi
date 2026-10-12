"use strict";
// Builds the marketing website (site/) into a folder GitHub Pages can publish, with the app's own fonts and icons.
// Usage: node scripts/build-site.js [out-dir]
// Settings come from the environment (the Pages workflow passes them from the repository's Actions variables):
//   DEMO_URL         where "Try the demo" goes (the running app, e.g. on Render or Fly.io)
//   EMAIL            the contact address
//   SITE_URL         the site's own address, for link previews, the sitemap and canonical links
//   WEB3FORMS_KEY    the contact form's Web3Forms access key. It's meant to be public (it can only send to our inbox).
//                    Without it the form opens an email to EMAIL instead.
//   CF_BEACON_TOKEN  Cloudflare Web Analytics token (cookieless). Without it, no analytics script is added.
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const out = path.resolve(root, process.argv[2] || "_site");
const cfg = {
  DEMO_URL: process.env.DEMO_URL || "https://app.domi.ysbdesigns.uk/?brand=domi", // the neutral demo, whatever brand the deployment defaults to
  EMAIL: process.env.EMAIL || "yameen@ysbdesigns.uk",
  SITE_URL: (process.env.SITE_URL || "https://domi.ysbdesigns.uk").replace(/\/$/, ""),
  WEB3FORMS_KEY: (process.env.WEB3FORMS_KEY || "").trim(),
};
const beacon = (process.env.CF_BEACON_TOKEN || "").trim();
if (cfg.WEB3FORMS_KEY && !/^[0-9a-f-]{36}$/i.test(cfg.WEB3FORMS_KEY)) throw new Error("WEB3FORMS_KEY doesn't look like a Web3Forms access key");
if (beacon && !/^[0-9a-f]{32}$/i.test(beacon)) throw new Error("CF_BEACON_TOKEN doesn't look like a Cloudflare Web Analytics token");
const esc = (t) => String(t).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

fs.rmSync(out, { recursive: true, force: true });
fs.cpSync(path.join(root, "site"), out, { recursive: true });
fs.mkdirSync(path.join(out, "fonts"));
for (const f of fs.readdirSync(path.join(root, "public", "fonts"))) {
  if (f.endsWith(".woff2")) fs.copyFileSync(path.join(root, "public", "fonts", f), path.join(out, "fonts", f));
}
for (const f of ["logo.svg", "favicon.svg", "favicon-32.png", "apple-touch-icon.png", "icon-192.png", "icon-512.png"]) fs.copyFileSync(path.join(root, "public", f), path.join(out, f));

const icons = ['<link rel="icon" href="/favicon.svg" type="image/svg+xml">', '<link rel="icon" href="/favicon-32.png" type="image/png" sizes="32x32">', '<link rel="apple-touch-icon" href="/apple-touch-icon.png">'].join("\n");
// Cloudflare's cookieless beacon: no cookies, no consent banner needed. No integrity hash: Cloudflare updates this
// unversioned script in place, so a pinned hash would silently switch analytics off.
const analytics = beacon ? `<script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='{"token": "${beacon}"}'></script>` : "";

/** The address a built file is served at: /, /privacy/, /404.html */
const urlOf = (rel) => "/" + rel.replace(/\\/g, "/").replace(/index\.html$/, "");
/** Link-preview tags from the page's own title and description. */
function socialFor(html, url) {
  const title = (html.match(/<title>([^<]*)<\/title>/) || [])[1] || "Domi";
  const description = (html.match(/<meta name="description" content="([^"]*)"/) || [])[1] || "";
  return [
    '<meta property="og:type" content="website">', '<meta property="og:site_name" content="Domi">',
    `<meta property="og:title" content="${title}">`, `<meta property="og:description" content="${description}">`,
    `<link rel="canonical" href="${esc(cfg.SITE_URL + url)}">`, `<meta property="og:url" content="${esc(cfg.SITE_URL + url)}">`,
    `<meta property="og:image" content="${esc(cfg.SITE_URL)}/social.jpg">`, '<meta property="og:image:width" content="1200">', '<meta property="og:image:height" content="630">',
    '<meta property="og:image:alt" content="Domi: the diary for healthcare that comes to the patient\'s home">',
    '<meta name="twitter:card" content="summary_large_image">',
  ].join("\n");
}

const pages = [];
(function walk(dir) {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (fs.statSync(p).isDirectory()) walk(p);
    else if (f.endsWith(".html")) pages.push(p);
  }
})(out);
for (const file of pages) {
  const rel = path.relative(out, file), url = urlOf(rel);
  let html = fs.readFileSync(file, "utf8");
  html = html.replace("<!--ICONS-->", icons).replace("<!--ANALYTICS-->", analytics).replace("<!--SOCIAL-->", () => socialFor(html, url));
  for (const [k, v] of Object.entries(cfg)) html = html.split(`%%${k}%%`).join(esc(v));
  const left = html.match(/%%[A-Z0-9_]+%%|<!--(ICONS|SOCIAL|ANALYTICS)-->/);
  if (left) throw new Error(`${rel} uses ${left[0]}, which build-site.js doesn't fill in`);
  fs.writeFileSync(file, html);
}

// Search engines: every page that should be found (not the thank-you or not-found pages).
const listed = pages.map((f) => path.relative(out, f)).filter((rel) => !/^(404\.html|thanks\/)/.test(rel)).map(urlOf).sort();
fs.writeFileSync(path.join(out, "sitemap.xml"), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${listed.map((u) => `  <url><loc>${esc(cfg.SITE_URL + u)}</loc></url>`).join("\n")}\n</urlset>\n`);
fs.writeFileSync(path.join(out, "robots.txt"), `User-agent: *\nAllow: /\nDisallow: /thanks/\n\nSitemap: ${cfg.SITE_URL}/sitemap.xml\n`);
fs.writeFileSync(path.join(out, ".nojekyll"), "");
console.log(`Built ${path.relative(root, out)}/ (${pages.length} pages; demo: ${cfg.DEMO_URL}; form: ${cfg.WEB3FORMS_KEY ? "Web3Forms" : "email fallback"}; analytics: ${beacon ? "Cloudflare" : "off"})`);
