"use strict";
// Live practices: real practices whose data is kept in Postgres (Supabase, London). Turned on by DATABASE_URL.
// Without it the server runs demos only, exactly as before.
const sandbox = require("./sandbox");
const brands = require("./brands");
const { openDb } = require("./db");
const pgs = require("./pgstore");

let pool = null;
const enabled = () => !!pool;

/** What a live practice keeps between restarts besides its tables: which daily jobs have run. */
const stateOf = (sb) => ({ remindedDay: sb.remindedDay || 0, recalledDay: sb.recalledDay || 0 });

async function open(rec) {
  const store = new pgs.Store(pool, rec.code);
  await store.ensure();
  const brand = brands.get(rec.brand);
  const db = openDb(brand, { empty: true });
  await store.load(db);
  const settings = { ...sandbox.defaults(brand), practice: rec.name, ...(rec.settings || {}) };
  const sb = sandbox.adopt({ id: rec.code, brand, db, settings, store, ...(rec.state || {}) });
  sb.flush = () => store.capture(sb.db, sb.settings, stateOf(sb));
  store.saved = { settings: JSON.stringify(settings), state: JSON.stringify(stateOf(sb)) };
  // Settings filled in from defaults (a new practice's lead key, say) are saved straight away.
  if (JSON.stringify(rec.settings || {}) !== store.saved.settings) { store.saved.settings = null; await sb.flush(); }
  return sb;
}

/** Connect and open every active practice. */
async function start(url = process.env.DATABASE_URL) {
  if (!url) return [];
  pool = pgs.pgPool(url);
  await pgs.ensureControl(pool);
  const opened = [];
  for (const rec of await pgs.listPractices(pool)) opened.push(await open(rec));
  return opened;
}

/** Add a practice (empty: its patients come in through Import) and open it. */
async function addPractice({ code, name, brand = "domi", settings = {} }) {
  if (!pool) throw new Error("No live database configured");
  code = String(code).toUpperCase();
  if (!/^[A-Z0-9]{3,12}$/.test(code)) throw new Error("A practice code is 3 to 12 letters or numbers");
  await pgs.addPractice(pool, { code, name, brand, settings });
  return open({ code, name, brand, settings, state: {} });
}

async function stop() { if (pool) { await sandbox.settle().catch(() => {}); await pool.end(); pool = null; } }

module.exports = { start, stop, addPractice, enabled, open, poolForTests: () => pool };
