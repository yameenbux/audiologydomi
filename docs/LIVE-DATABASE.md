# The live database (Supabase, London)

Domi has two ways to run:

- **Demo** (the default): every visitor gets a private sample practice in memory. Nothing is kept. This is what
  runs on Render, and it never holds real patients.
- **Live** (`DEMO_MODE=0` and `DATABASE_URL` set): real practices, saved in **Postgres on Supabase**, project
  `tcccdmgivehgcgchvwcb`, region **eu-west-2 (London)**, with the app on **Fly.io London** (`fly.toml`).

## How a live practice is saved

A live practice runs on exactly the same in-memory SQLite database as a demo, so every booking rule, transaction and
test is unchanged. Postgres is the record that survives restarts (`server/pgstore.js`, `server/live.js`):

1. On start-up each practice is loaded from Postgres into memory.
2. Triggers note every row that changes. When a change commits, those rows are read and written to Postgres in one
   Postgres transaction, in order.
3. The server answers only once the change is in Postgres. If Postgres can't be reached after three tries, the office
   sees "That couldn't be saved just now", and texts about that change are held back.
4. Settings, and which daily jobs have run, are saved with the practice in `domi.practices`.

Layout in Postgres:

| Where | What |
|---|---|
| `domi.practices` | One row per practice: code, name, look, settings, daily-job state |
| `p_<code>.*` | That practice's tables (patients, visits, waiting list, offers, recalls, messages, PCSE tasks, referrals, leads, invoices, users, audit), made by the server from the app's own table definitions |

Each practice has its own schema, so practices can never see each other's rows.

**The one limit:** it assumes **one server machine** (it keeps each practice in memory). That is plenty for many small
practices; running several machines at once would need the data layer rewritten to talk to Postgres directly.

## Security

- Domi's schemas aren't exposed by the Supabase Data API, nothing is granted to the `anon` or `authenticated` roles,
  and every table has row level security on with no policies. The advisor's "RLS enabled, no policy" notices are expected.
- The server signs in as its own role, `domi_app`, which owns Domi's schemas. The connection is encrypted and the
  certificate checked (`DATABASE_CA_CERT`).
- With the demo off: there are no sample practices, no demo password, no "fill in the code" shortcut and no phone
  pairing by QR. New accounts get a random password nobody knows.
- Patient erasure (UK GDPR) still removes names from the audit trail, so the audit table is not made append-only.

## Setting up a practice

```bash
node --experimental-sqlite scripts/live-admin.js add-practice HVO "Home Visiting Optics" hvo
node --experimental-sqlite scripts/live-admin.js add-admin HVO office@example.co.uk "Full Name"   # prints a password and a 2FA link, once
node --experimental-sqlite scripts/live-admin.js list
```

Then restart the app so it loads the change. The office adds clinicians and imports patients from inside Domi.

## Before any real patient data goes in

1. Sign Supabase's data processing agreement (Dashboard → Organization → Legal documents).
2. Sign the data processing agreement with the practice, and check their DSPT is in place.
3. In the SQL editor: `alter role domi_app login password '<long password>';` (never share it).
4. `fly secrets set DATABASE_URL=... DATABASE_CA_CERT="$(cat prod-ca-2021.crt)"` plus the Twilio secrets.
5. Consider point-in-time recovery (a paid Supabase add-on); Pro includes daily backups.

## Still to do before go-live

- **A real calendar.** The diary still works on the demo's fixed week (Monday 12 to Friday 16 October): day numbers,
  labels and texts. A live practice needs rolling dates, weekends, bank holidays and the PCSE 48-hour rule counted on
  working days.
- **Staff sign-in set-up.** A way for the office to invite staff to set their own password and two-factor app, and to
  reset them. Today only the first office account is made, by `live-admin.js`.
- **Sessions that survive a restart.** Sign-ins are held in memory, so a restart signs everyone out.
