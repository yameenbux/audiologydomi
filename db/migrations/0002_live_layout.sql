-- Applied to Supabase project tcccdmgivehgcgchvwcb on 16 Oct 2026. Replaces the first draft (0001, never used,
-- renamed to domi_draft_unused and safe to delete) with the layout the Domi server manages itself:
--   domi.practices      one row per practice: name, look, settings, daily-job state
--   p_<code>.*          each practice's own tables, created by the server (server/pgstore.js) from the same
--                       definitions the app uses, with row level security on and nothing granted to the API roles.
grant domi_app to postgres;
alter schema domi rename to domi_draft_unused;
create schema domi authorization domi_app;
revoke all on schema domi from public, anon, authenticated;
grant create on database postgres to domi_app;   -- so the server can make each practice's schema
create table domi.practices (
  code text primary key, name text not null, brand text not null default 'domi',
  settings jsonb not null default '{}'::jsonb, state jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), active boolean not null default true
);
alter table domi.practices owner to domi_app;
alter table domi.practices enable row level security;

-- To do in the dashboard's SQL editor before go-live (choose your own long password; never share it):
--   alter role domi_app login password '...';
-- DATABASE_URL: copy the "Session pooler" string from the project's Connect dialog, then put domi_app.tcccdmgivehgcgchvwcb
-- as the user and domi_app's password in it.
