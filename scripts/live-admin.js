#!/usr/bin/env node
"use strict";
// Set up live practices. Needs DATABASE_URL (and DATABASE_CA_CERT for Supabase) in the environment.
//
//   node --experimental-sqlite scripts/live-admin.js list
//   node --experimental-sqlite scripts/live-admin.js add-practice HVO "Home Visiting Optics" hvo
//   node --experimental-sqlite scripts/live-admin.js add-admin HVO zain@example.co.uk "Zain Example"
//
// add-admin prints a strong random password and a two-factor set-up link, once. Give them to the person
// privately; they scan the link into an authenticator app. Restart the app afterwards so it loads the change
// (the running server keeps each practice in memory).
const crypto = require("node:crypto");
const live = require("../server/live");
const sandbox = require("../server/sandbox");
const auth = require("../server/auth");
const { db } = require("../server/db");

const [cmd, ...args] = process.argv.slice(2);
const fail = (m) => { console.error(m); process.exit(1); };

(async () => {
  if (!process.env.DATABASE_URL) fail("Set DATABASE_URL first.");
  const open = await live.start();
  const find = (code) => open.find((s) => s.id === String(code || "").toUpperCase()) || fail(`No practice ${code}. Run "list".`);
  if (cmd === "list") {
    for (const sb of open) {
      const n = sandbox.run(sb, () => db.prepare("SELECT (SELECT COUNT(*) FROM patients) AS patients, (SELECT COUNT(*) FROM users WHERE active = 1) AS users").get());
      console.log(`${sb.id}\t${sb.settings.practice}\t${n.patients} patients\t${n.users} accounts`);
    }
  } else if (cmd === "add-practice") {
    const [code, name, brand = "domi"] = args;
    if (!code || !name) fail('Usage: add-practice CODE "Practice name" [brand]');
    const sb = await live.addPractice({ code, name, brand });
    console.log(`Added ${sb.id} (${name}). Add its first office account with add-admin.`);
  } else if (cmd === "add-admin") {
    const [code, email, name] = args;
    if (!code || !email || !name) fail('Usage: add-admin CODE email "Full name"');
    const sb = find(code);
    const password = crypto.randomBytes(12).toString("base64url");
    const secret = auth.newSecret();
    sandbox.run(sb, () => {
      if (db.prepare("SELECT 1 FROM users WHERE email = ?").get(email.toLowerCase())) fail("That email already has an account.");
      const id = "u-" + crypto.randomUUID().replace(/-/g, "").slice(0, 10);
      db.prepare("INSERT INTO users (id, name, role, email, pass_hash, totp_secret, title, color) VALUES (?, ?, 'admin', ?, ?, ?, 'Office', '#5B6770')")
        .run(id, name, email.toLowerCase(), auth.hashPassword(password), secret);
      db.prepare("INSERT INTO audit (ts, actor, action, entity, detail) VALUES (?, 'setup', 'user.add', ?, 'First office account, added with live-admin')").run(sandbox.stamp(sb), id);
    });
    await sandbox.settle();
    console.log(`Account for ${name} <${email}> in ${sb.id}.`);
    console.log(`Password (shown once): ${password}`);
    console.log(`Two-factor set-up link (scan as a QR code, or paste into an authenticator app): ${auth.otpauthUri(secret, email)}`);
    console.log("Now restart the app so it loads the new account.");
  } else {
    fail("Commands: list, add-practice, add-admin");
  }
  await live.stop();
})().catch((e) => fail(e.message));
