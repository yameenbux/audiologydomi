# The live database (Supabase, London)

Domi's demo runs on an in-memory SQLite database per visitor (`server/db.js`, `server/sandbox.js`). Real practices
need a permanent database, so the live service uses **Postgres on Supabase**, project `tcccdmgivehgcgchvwcb`,
region **eu-west-2 (London)**.

## What lives where

| Piece | Where | Why |
|---|---|---|
| Patients, visits, waiting list, offers, recalls, messages, PCSE tasks, referrals, leads, invoices, users, sessions, audit | Supabase Postgres, schema `domi` | Permanent, backed up, in London |
| Logos, imported spreadsheets, invoice PDFs | Supabase Storage, private bucket `practice-files` | Private files next to the data |
| The Domi server (booking rules, texts, Meta webhook, daily sweeps, live updates, sign-in with two-step codes) | Fly.io, London (`lhr`) | Long-running Node server; Supabase Edge Functions are short-lived |
| The demo | In memory, as now | Prospects must never touch real data |
| The marketing site | GitHub Pages | Unchanged |

## Security model

- Tables are in their own schema, `domi`, which the Supabase Data API does not expose. The browser never talks to
  Supabase; only the Domi server does.
- Row level security is on for every table with **no policies**, and `anon`/`authenticated` have no grants, so even
  a leaked public API key reads nothing. The advisor's "RLS enabled, no policy" notices are expected.
- The server connects as its own role, `domi_app` (created without a password, so it can't log in yet). Set its
  password in the Supabase dashboard and give the connection string to Fly as a secret (`DATABASE_URL`); never commit it.
- `domi_app` can't update or delete audit rows, and a trigger blocks it for everyone else too: the audit log is append-only.
- Every row carries `practice_id`, so one database serves many practices without mixing their data.
- Visits have a real `visit_date` (the demo uses "days from today").

The schema is `db/migrations/0001_domi_core.sql`; it has been applied to the project.

## Before any real patient data goes in

1. Sign Supabase's data processing agreement (Dashboard → Organization → Legal documents).
2. Sign the data processing agreement with the practice (HVO), and their DSPT is in place.
3. Turn on point-in-time recovery (paid add-on) or accept the daily backups that come with Pro.
4. Set the `domi_app` password and put `DATABASE_URL` in Fly secrets.

## Code work still to do

The service layer (`server/service.js`, about 1,400 lines) calls SQLite synchronously (`one`, `all`, `run`, and
`db.exec("BEGIN")` transactions). Postgres is asynchronous, so the change is:

1. A small data layer with the same three calls, made `async`, with two drivers: SQLite for the demo and tests,
   Postgres (`pg`, the first outside package) for live.
2. Make every service function `async` and await it in `server/index.js`; transactions become `BEGIN … COMMIT` on one
   pooled connection, with texts and live events still released only after commit.
3. Replace "day" numbers with real dates in live mode, and add `practice_id` to every query.
4. Move the sweeps (reminders, recalls, offer expiry) to run once per practice from the live database.
5. Run the existing tests against both drivers.

Estimate: several days of focused work. Planned as part of the Phase 1 go-live.
