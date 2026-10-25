"use strict";
// The marketing website builds, fills in every setting, and loads nothing from other companies.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

test("website builds with its settings filled in and no third-party requests", () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "domi-site-"));
  execFileSync(process.execPath, [path.join(__dirname, "..", "scripts", "build-site.js"), out], {
    env: { ...process.env, DEMO_URL: "https://demo.example", EMAIL: "hello@example.com", SITE_URL: "https://domi.example/" },
  });
  const html = fs.readFileSync(path.join(out, "index.html"), "utf8");
  assert.doesNotMatch(html, /%%[A-Z_]+%%/);
  assert.match(html, /href="https:\/\/demo\.example"/);
  assert.match(html, /mailto:hello@example\.com/);
  assert.match(html, /og:image" content="https:\/\/domi\.example\/social\.jpg"/);
  // Scripts, styles, fonts and images all come from this site
  const external = [...html.matchAll(/(?:src|url)\(?=?["']?(https?:[^"')\s]+)/g)].map((m) => m[1]);
  assert.deepStrictEqual(external, []);
  for (const m of html.matchAll(/(?:src|href|poster)="((?:shots|fonts|film)\/[^"]+|logo\.svg|favicon\.svg)"/g)) {
    assert.ok(fs.existsSync(path.join(out, m[1])), `${m[1]} is missing from the build`);
  }
  for (const m of html.matchAll(/url\((fonts\/[^)]+)\)/g)) assert.ok(fs.existsSync(path.join(out, m[1])), `${m[1]} is missing`);
  fs.rmSync(out, { recursive: true, force: true });
});

const build = (env) => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "domi-site-"));
  execFileSync(process.execPath, [path.join(__dirname, "..", "scripts", "build-site.js"), out], { env: { ...process.env, SITE_URL: "https://domi.example", WEB3FORMS_KEY: "", CF_BEACON_TOKEN: "", ...env } });
  return { out, read: (f) => fs.readFileSync(path.join(out, f), "utf8"), done: () => fs.rmSync(out, { recursive: true, force: true }) };
};

const SECTORS = ["domiciliary-opticians", "audiology", "podiatry", "physiotherapy"];

test("privacy, terms, thank-you, not-found and sector pages: titles, descriptions, previews, breadcrumbs and working links", () => {
  const b = build({});
  for (const f of ["privacy/index.html", "security/index.html", "terms/index.html", "thanks/index.html", "video/index.html", "404.html", ...SECTORS.map((s) => s + "/index.html")]) {
    const html = b.read(f);
    assert.match(html, /<title>[^<]+ · Domi<\/title>/, f);
    assert.match(html, /<meta name="description" content="[^"]{40,}">/, f);
    assert.match(html, /apple-touch-icon\.png/, f);
    assert.match(html, /aria-label="Breadcrumb"/, f);
    // Every link to a page on this site goes somewhere that exists
    for (const m of html.matchAll(/href="(\/[^"#]*)/g)) {
      const target = m[1] === "/" ? "index.html" : m[1].endsWith("/") ? m[1].slice(1) + "index.html" : m[1].slice(1);
      assert.ok(fs.existsSync(path.join(b.out, target)), `${f} links to ${m[1]}, which isn't built`);
    }
  }
  assert.match(b.read("privacy/index.html"), /canonical" href="https:\/\/domi\.example\/privacy\/"/);
  assert.match(b.read("privacy/index.html"), /"@type":"BreadcrumbList"/);
  assert.match(b.read("terms/index.html"), /og:title" content="Terms and conditions · Domi"/);
  // AI assistants get the same pages, each with its own description
  const llms = b.read("llms.txt");
  assert.match(llms, /^# Domi\n\n> .{40,}/);
  for (const u of ["/", "/security/", "/domiciliary-opticians/"]) assert.ok(llms.includes(`](https://domi.example${u}): `), u);
  assert.doesNotMatch(llms, /\]\([^)]*\): \n/, "every page has a description");
  // The founding price is stated in four places on the homepage; they change together or not at all
  const home = b.read("index.html");
  const offer = JSON.parse(home.match(/<script type="application\/ld\+json">(\{"@context":"https:\/\/schema\.org","@graph".*?)<\/script>/)[1])["@graph"].find((n) => n.offers).offers;
  const price = home.match(/data-count="(\d+)">\d+<\/span><small>a month/)[1];
  assert.strictEqual(offer.price, price, "structured data and the price card agree");
  for (const needle of [/Founding price, for our first five practices/, /first five practices pay a founding price of £160 a month/, /<b>Founding price<\/b> for our first five practices/, /Founding price for the first five practices/]) assert.match(home, needle);
  const sitemap = b.read("sitemap.xml");
  assert.deepStrictEqual([...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]), ["https://domi.example/", ...SECTORS.slice().sort().map((s) => `https://domi.example/${s}/`), "https://domi.example/privacy/", "https://domi.example/security/", "https://domi.example/terms/", "https://domi.example/video/"]);
  // The homepage links to each sector page, and each one says what isn't built yet
  for (const s of SECTORS) {
    assert.match(b.read("index.html"), new RegExp(`href="/${s}/"`), s);
    assert.match(b.read(s + "/index.html"), /Not built yet/, s);
    assert.match(b.read(s + "/index.html"), /"@type":"FAQPage"/, s);
  }
  assert.match(b.read("robots.txt"), /Sitemap: https:\/\/domi\.example\/sitemap\.xml/);
  b.done();
});

test("the contact form falls back to email without a Web3Forms key; analytics only with a Cloudflare token", () => {
  const off = build({});
  const html = off.read("index.html");
  assert.match(html, /id="enquiry"[^>]*data-key=""/);
  assert.match(html, /name="botcheck"/, "spam trap");
  assert.doesNotMatch(html, /cloudflareinsights/);
  off.done();
  const on = build({ WEB3FORMS_KEY: "12345678-abcd-4def-8123-1234567890ab", CF_BEACON_TOKEN: "0123456789abcdef0123456789abcdef" });
  const live = on.read("index.html");
  assert.match(live, /name="access_key" value="12345678-abcd-4def-8123-1234567890ab"/);
  assert.match(live, /name="redirect" value="https:\/\/domi\.example\/thanks\/"/);
  for (const f of ["index.html", "privacy/index.html", "thanks/index.html"]) assert.match(on.read(f), /static\.cloudflareinsights\.com\/beacon\.min\.js" data-cf-beacon='\{"token": "0123456789abcdef0123456789abcdef"\}'/);
  on.done();
  assert.throws(() => build({ CF_BEACON_TOKEN: "not a token" }));
});

test("the technical page that names Domi's suppliers is off unless a developer switches it on", async () => {
  const { spawn } = require("node:child_process");
  const port = 3900 + Math.floor(Math.random() * 90);
  const env = { ...process.env, PORT: String(port) }; delete env.UNDER_THE_HOOD;
  const srv = spawn(process.execPath, ["--experimental-sqlite", "--no-warnings", path.join(__dirname, "..", "server", "index.js")], { env, stdio: "ignore" });
  try {
    let up = false;
    for (let i = 0; i < 50 && !up; i++) { try { await fetch(`http://localhost:${port}/api/meta`); up = true; } catch { await new Promise((r) => setTimeout(r, 100)); } }
    assert.ok(up, "server started");
    for (const p of ["/under-the-hood", "/under-the-hood.html"]) assert.strictEqual((await fetch(`http://localhost:${port}${p}`)).status, 404, p);
    assert.doesNotMatch(await (await fetch(`http://localhost:${port}/`)).text(), /under-the-hood/);
  } finally { srv.kill(); }
});
