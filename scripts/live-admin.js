#!/usr/bin/env node
"use strict";
// Set up live practices. Needs DATABASE_URL (and DATABASE_CA_CERT for Supabase) in the environment.
//
//   node --experimental-sqlite scripts/live-admin.js list
//   node --experimental-sqlite scripts/live-admin.js add-practice HVO "Home Visiting Optics" hvo
//   node --experimental-sqlite scripts/live-admin.js add-admin HVO zain@example.co.uk "Zain Example"
//
// add-admin emails the person an invitation (when email sending is set up) and prints the same link, once. On it
// they choose their own password and set up their authenticator app; nobody else ever knows either. It needs
// PUBLIC_URL (the address people use, like https://app.domi.ysbdesigns.uk). Restart the app afterwards so it
// loads the new account (the running server keeps each practice in memory).
const crypto = require("node:crypto");
const live = require("../server/live");
const sandbox = require("../server/sandbox");
const auth = require("../server/auth");
const invites = require("../server/invites");
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
    if (!process.env.PUBLIC_URL) fail("Set PUBLIC_URL to the address people use, like https://app.domi.ysbdesigns.uk");
    const sb = find(code);
    const invite = await sandbox.run(sb, async () => {
      if (db.prepare("SELECT 1 FROM users WHERE email = ?").get(email.toLowerCase())) fail("That email already has an account.");
      const id = "u-" + crypto.randomUUID().replace(/-/g, "").slice(0, 10);
      db.prepare("INSERT INTO users (id, name, role, email, pass_hash, totp_secret, title, color) VALUES (?, ?, 'admin', ?, ?, ?, 'Office', '#5B6770')")
        .run(id, name, email.toLowerCase(), invites.unusable(), auth.newSecret());
      db.prepare("INSERT INTO audit (ts, actor, action, entity, detail) VALUES (?, 'setup', 'user.add', ?, 'First office account, added with live-admin')").run(sandbox.stamp(sb), id);
      const r = invites.issue(id, { name: "Domi set-up" }, process.env.PUBLIC_URL, { isNew: true });
      await sandbox.settle();
      if (r.emailed) await new Promise((ok) => setTimeout(ok, 4000)); // the email goes once the account is saved: let it send
      return r;
    });
    console.log(`Account for ${name} <${email}> in ${sb.id}.`);
    console.log(`Invitation ${invite.emailed ? "emailed to them" : "NOT emailed (email sending isn't set up): send them this link privately"}.`);
    console.log(`Link (shown once, works once, expires in 7 days): ${invite.url}`);
    console.log("Now restart the app so it loads the new account.");
  } else {
    fail("Commands: list, add-practice, add-admin");
  }
  await live.stop();
})().catch((e) => fail(e.message));
