"use strict";
// The live store. A live practice runs on the same in-memory SQLite database as a demo, so every booking rule,
// transaction and test stays exactly as it is. Postgres (Supabase, London) is the record that survives restarts:
//
//  - each practice has its own Postgres schema (p_<code>), made from the same table definitions as SQLite;
//  - on start-up the practice is loaded from Postgres into memory;
//  - triggers note every row that changes; when a transaction commits, those rows are read and written to
//    Postgres in order, in one Postgres transaction;
//  - the server answers a request only once its changes are in Postgres, and texts go out only after that.
//
// It assumes one server process per practice (one Fly machine), which is how Domi runs.
const { SCHEMA, TABLES, ADDED_COLUMNS } = require("./db");

let Pool = null;
const pgPool = (url) => {
  Pool = Pool || require("pg").Pool; // only needed when a live database is configured: the demo has no packages
  // Encrypted and checked against Supabase's certificate (DATABASE_CA_CERT: the "SSL certificate" from the project's
  // database settings, as text). Only a database on this machine, used by the tests, skips encryption.
  const local = /@(localhost|127\.0\.0\.1)[:/]|host=\/|@\/|%2F/.test(url);
  const ca = process.env.DATABASE_CA_CERT;
  if (!local && !ca) throw new Error("DATABASE_CA_CERT is needed to check the database's certificate");
  return new Pool({ connectionString: url, max: 5, ssl: local ? false : { ca, rejectUnauthorized: true } });
};

const qi = (s) => '"' + String(s).replace(/"/g, '""') + '"';
const schemaFor = (code) => "p_" + String(code).toLowerCase().replace(/[^a-z0-9_]/g, "");

/** The SQLite table definitions, written for Postgres. Keys, defaults and checks are the same; links between tables
 *  are left to SQLite, which enforces them before anything reaches Postgres. */
function pgDDL() {
  return SCHEMA
    .replace(/--[^\n]*/g, "")
    .replace(/INTEGER PRIMARY KEY AUTOINCREMENT/g, "BIGINT PRIMARY KEY")
    .replace(/\bINTEGER\b/g, "BIGINT")
    .replace(/\s+REFERENCES\s+\w+\(\w+\)/g, "");
}

class Store {
  constructor(pool, code) {
    this.pool = pool; this.code = code; this.schema = schemaFor(code);
    this.queue = Promise.resolve(); this.error = null; this.saved = { settings: null, state: null };
  }

  /** Make the practice's schema and tables if they aren't there yet. */
  async ensure() {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      await c.query(`CREATE SCHEMA IF NOT EXISTS ${qi(this.schema)}`);
      await c.query(`SET LOCAL search_path TO ${qi(this.schema)}`);
      await c.query(pgDDL());
      for (const [t, col, type] of ADDED_COLUMNS) await c.query(`ALTER TABLE ${qi(t)} ADD COLUMN IF NOT EXISTS ${qi(col)} ${type}`);
      // Belt and braces on Supabase: row level security on, no policies, nothing granted to the API roles. Only the
      // schema's owner (the Domi server) can read or write.
      for (const t of TABLES) await c.query(`ALTER TABLE ${qi(t)} ENABLE ROW LEVEL SECURITY`);
      await c.query(`REVOKE ALL ON SCHEMA ${qi(this.schema)} FROM PUBLIC`);
      await c.query("COMMIT");
    } catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; } finally { c.release(); }
  }

  /** Copy every row from Postgres into a fresh SQLite database, parents before children. */
  async load(db) {
    const c = await this.pool.connect();
    try {
      db.exec("BEGIN");
      for (const t of [...TABLES].reverse()) {
        const { rows, fields } = await c.query(`SELECT * FROM ${qi(this.schema)}.${qi(t)} ORDER BY id`);
        if (!rows.length) continue;
        const cols = fields.map((f) => f.name);
        const ins = db.prepare(`INSERT INTO ${t} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`);
        for (const r of rows) ins.run(...cols.map((k) => r[k]));
      }
      db.exec("COMMIT");
    } catch (e) { try { db.exec("ROLLBACK"); } catch {} throw e; } finally { c.release(); }
    this.watch(db);
  }

  /** Triggers that note which rows change. */
  watch(db) {
    db.exec("CREATE TABLE IF NOT EXISTS _changes (seq INTEGER PRIMARY KEY AUTOINCREMENT, tbl TEXT NOT NULL, id TEXT NOT NULL)");
    for (const t of TABLES) {
      db.exec(`CREATE TRIGGER IF NOT EXISTS _ins_${t} AFTER INSERT ON ${t} BEGIN INSERT INTO _changes (tbl, id) VALUES ('${t}', NEW.id); END;
               CREATE TRIGGER IF NOT EXISTS _upd_${t} AFTER UPDATE ON ${t} BEGIN INSERT INTO _changes (tbl, id) VALUES ('${t}', NEW.id); END;
               CREATE TRIGGER IF NOT EXISTS _del_${t} AFTER DELETE ON ${t} BEGIN INSERT INTO _changes (tbl, id) VALUES ('${t}', OLD.id); END;`);
    }
  }

  /** Read what changed since last time, as it is now: the rows to write and the rows to remove. Synchronous, so it
   *  runs straight after a commit, before anything else can change those rows. */
  capture(db, settings, state) {
    const seen = db.prepare("SELECT tbl, id, MAX(seq) AS seq FROM _changes GROUP BY tbl, id ORDER BY seq").all();
    const batch = [];
    if (seen.length) {
      db.prepare("DELETE FROM _changes").run();
      for (const { tbl, id } of seen) {
        const row = db.prepare(`SELECT * FROM ${tbl} WHERE id = ?`).get(id);
        batch.push({ tbl, id, row: row ? { ...row } : null });
      }
    }
    const s = JSON.stringify(settings), st = JSON.stringify(state);
    const meta = s !== this.saved.settings || st !== this.saved.state ? { settings: s, state: st } : null;
    if (meta) { this.saved.settings = s; this.saved.state = st; }
    if (!batch.length && !meta) return null;
    return this.enqueue(batch, meta);
  }

  enqueue(batch, meta) {
    this.queue = this.queue.then(() => this.write(batch, meta));
    return this.queue;
  }

  async write(batch, meta) {
    for (let attempt = 1; ; attempt++) {
      const c = await this.pool.connect().catch((e) => { throw e; });
      try {
        await c.query("BEGIN");
        for (const { tbl, id, row } of batch) {
          const T = `${qi(this.schema)}.${qi(tbl)}`;
          if (!row) { await c.query(`DELETE FROM ${T} WHERE id = $1`, [id]); continue; }
          const cols = Object.keys(row);
          const set = cols.filter((k) => k !== "id").map((k) => `${qi(k)} = EXCLUDED.${qi(k)}`);
          await c.query(`INSERT INTO ${T} (${cols.map(qi).join(",")}) VALUES (${cols.map((_, i) => "$" + (i + 1)).join(",")})
                         ON CONFLICT (id) DO ${set.length ? "UPDATE SET " + set.join(",") : "NOTHING"}`, cols.map((k) => row[k]));
        }
        if (meta) await c.query("UPDATE domi.practices SET settings = $2::jsonb, state = $3::jsonb, updated_at = now() WHERE code = $1", [this.code, meta.settings, meta.state]);
        await c.query("COMMIT");
        this.error = null;
        return;
      } catch (e) {
        await c.query("ROLLBACK").catch(() => {});
        this.error = e;
        if (attempt >= 3) { console.error(`live store: couldn't save ${this.code}`, e.message); throw e; }
        await new Promise((r) => setTimeout(r, 250 * attempt));
      } finally { c.release(); }
    }
  }

  /** Resolves once everything captured so far is in Postgres. */
  settled() { return this.queue; }
}

/* ---------- The list of practices (control schema "domi") ---------- */
const CONTROL = `
CREATE SCHEMA IF NOT EXISTS domi;
CREATE TABLE IF NOT EXISTS domi.practices (
  code TEXT PRIMARY KEY, name TEXT NOT NULL, brand TEXT NOT NULL DEFAULT 'domi',
  settings JSONB NOT NULL DEFAULT '{}'::jsonb, state JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), active BOOLEAN NOT NULL DEFAULT true
);`;

async function ensureControl(pool) { await pool.query(CONTROL); }
async function listPractices(pool) {
  const { rows } = await pool.query("SELECT code, name, brand, settings, state FROM domi.practices WHERE active ORDER BY created_at");
  return rows;
}
async function addPractice(pool, { code, name, brand = "domi", settings }) {
  await pool.query("INSERT INTO domi.practices (code, name, brand, settings) VALUES ($1, $2, $3, $4::jsonb)", [code, name, brand, JSON.stringify(settings || {})]);
}

module.exports = { Store, pgPool, pgDDL, schemaFor, ensureControl, listPractices, addPractice };
