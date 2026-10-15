"use strict";
// Every visitor gets a private copy of the demo: its own in-memory database, settings and clock.
// Requests run inside AsyncLocalStorage, so the rest of the server code reads "the current sandbox"
// without passing it around. Laptop and phone share one sandbox by joining with its code.
const { AsyncLocalStorage } = require("node:async_hooks");
const crypto = require("node:crypto");
const brands = require("./brands");

const als = new AsyncLocalStorage();
const sandboxes = new Map();
const MAX = Number(process.env.MAX_SANDBOXES || 100);
const IDLE_MS = 3 * 3600e3;
const DEMO_START = 10 * 60 + 20; // each demo opens at 10:20 on the sample Monday
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O or 1/I/L, so codes are easy to read aloud

let openDb = null; // injected by db.js to avoid a require cycle
// reminderAt: when the day-before reminders go out (minutes after midnight on the demo clock).
// practice: the practice's name, as patients see it in texts, on the booking page and on invoices. The product is Domi.
// The default practice is invented for the demo (server/brands.js); a branded demo uses the practice's own name.
const defaults = (brand = brands.get()) => ({ practice: brand.practice, mode: "offer", offerMinutes: Number(process.env.OFFER_MINUTES || 20), fee: 85, reminders: true, reminderAt: 17 * 60,
  // Given in the thank-you email each ad lead gets, so they know when the office will call.
  officeHours: brand.officeHours || "Monday to Friday, 9am to 5pm",
  // Price per visit type, in pounds. 0 = no invoice to the patient: NHS sight tests are claimed from the NHS
  // on a GOS 6 form, and glasses are charged when they're ordered (or paid for with an NHS voucher).
  prices: { sight: 0, exam: 65, dispense: 0, repair: 15, follow: 35 } });

function newCode() {
  let c;
  do { c = Array.from(crypto.randomBytes(6), (b) => ALPHABET[b % ALPHABET.length]).join(""); } while (sandboxes.has(c));
  return c;
}

function evict() {
  const now = Date.now();
  for (const [id, sb] of sandboxes) if (now - sb.lastSeen > IDLE_MS) { sb.db.close(); sandboxes.delete(id); }
  while (sandboxes.size >= MAX) {
    const oldest = [...sandboxes.values()].sort((a, b) => a.lastSeen - b.lastSeen)[0];
    oldest.db.close(); sandboxes.delete(oldest.id);
  }
}

function create(brandId) {
  evict();
  const brand = brands.get(brandId);
  const sb = { id: newCode(), brand, db: openDb(brand), settings: defaults(brand), t0: Date.now(), lastSeen: Date.now(), txDepth: 0, pending: null };
  sandboxes.set(sb.id, sb);
  return sb;
}

function get(id) {
  const sb = sandboxes.get(String(id || "").toUpperCase());
  if (sb) sb.lastSeen = Date.now();
  return sb || null;
}

function reset(sb) {
  sb.db.close();
  sb.db = openDb(sb.brand);
  sb.settings = defaults(sb.brand);
  sb.t0 = Date.now();
  sb.remindedDay = 0;
}

const run = (sb, fn) => als.run(sb, fn);
function current() {
  const sb = als.getStore();
  if (!sb) throw new Error("No sandbox in context");
  return sb;
}

/* Demo clock: starts at 10:20 when the sandbox is created and runs in real time. */
const nowSec = (sb = current()) => DEMO_START * 60 + Math.floor((Date.now() - sb.t0) / 1000);
const nowMin = (sb = current()) => Math.floor(nowSec(sb) / 60);
const pad = (n) => String(n).padStart(2, "0");
const stamp = (sb = current()) => { const s = nowSec(sb); return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`; };

module.exports = { create, get, reset, run, current, all: () => [...sandboxes.values()], nowMin, nowSec, stamp, setOpener: (f) => { openDb = f; } };
