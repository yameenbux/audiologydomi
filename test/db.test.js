"use strict";
// Fails the build if this Node version can't load node:sqlite, instead of crashing after deploy.
const test = require("node:test");
const assert = require("node:assert");

test("a sandbox database opens and seeds the demo data", () => {
  const { openDb } = require("../server/db");
  const db = openDb();
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM clinicians").get().n, 3);
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM waitlist").get().n, 6);
});
