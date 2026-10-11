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
  for (const m of html.matchAll(/(?:src|href)="((?:shots|fonts)\/[^"]+|logo\.svg|favicon\.svg)"/g)) {
    assert.ok(fs.existsSync(path.join(out, m[1])), `${m[1]} is missing from the build`);
  }
  for (const m of html.matchAll(/url\((fonts\/[^)]+)\)/g)) assert.ok(fs.existsSync(path.join(out, m[1])), `${m[1]} is missing`);
  fs.rmSync(out, { recursive: true, force: true });
});
