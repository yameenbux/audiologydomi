"use strict";
// Fails the build if this Node version can't load node:sqlite, instead of crashing after deploy.
process.env.DB_FILE = ":memory:";
const test = require("node:test");
const assert = require("node:assert");

test("database opens and seeds the demo data", () => {
  const { db } = require("../server/db");
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM clinicians").get().n, 3);
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM waitlist").get().n, 6);
});
