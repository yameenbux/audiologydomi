-- Domi production schema. Applied to Supabase project tcccdmgivehgcgchvwcb (eu-west-2) on 16 Oct 2026.
-- Lives in its own schema, "domi", which the Supabase Data API does not expose: browsers never reach these tables.
-- Only the Domi server connects, with its own database role (domi_app).
create schema if not exists domi;
revoke all on schema domi from public, anon, authenticated;

create extension if not exists pgcrypto with schema extensions;

create table domi.practices (
  id uuid primary key default extensions.gen_random_uuid(),
  code text not null unique,                       -- short public code used in links (/refer/<code>, /book/<code>)
  name text not null,
  company_number text,
  settings jsonb not null default '{}'::jsonb,     -- hours, visit types and prices, reminder and recall times, wording
  secrets jsonb not null default '{}'::jsonb,      -- Facebook/Meta tokens, lead key: never sent to the browser
  created_at timestamptz not null default now()
);

create table domi.clinicians (
  id text primary key, practice_id uuid not null references domi.practices(id),
  name text not null, first text not null, role text not null, color text not null,
  area_name text not null, patch text not null, near text not null, base text not null,
  hours jsonb not null,                            -- per weekday Mon-Fri: [start, end] in minutes, or null for a day off
  active boolean not null default true
);

create table domi.users (
  id text primary key, practice_id uuid not null references domi.practices(id),
  name text not null, role text not null check (role in ('admin','clinician')),
  clinician_id text references domi.clinicians(id),
  email text not null unique, pass_hash text not null, totp_secret text not null,
  totp_step bigint not null default -1, failed int not null default 0, locked_until bigint not null default 0,
  title text, color text, active boolean not null default true
);

create table domi.sessions (
  token_hash text primary key, user_id text not null references domi.users(id),
  created_at timestamptz not null default now(), expires_at timestamptz not null, last_seen timestamptz
);

create table domi.patients (
  id text primary key, practice_id uuid not null references domi.practices(id),
  name text not null, age int, addr text not null, pc text not null, phone text not null,
  contact text not null default 'Text', alerts jsonb not null default '[]'::jsonb,
  specs text not null default 'None on record', rx text, dob date, email text,
  eligibility text, rep text, poa text, share text check (share in ('yes','no')),
  last_test date, erased boolean not null default false,
  created_at timestamptz not null default now()
);

create table domi.notes (
  id bigint generated always as identity primary key, practice_id uuid not null references domi.practices(id),
  patient_id text not null references domi.patients(id), label text not null, body text not null,
  author text, created_at timestamptz not null default now()
);

create table domi.appointments (
  id text primary key, practice_id uuid not null references domi.practices(id),
  clinician_id text not null references domi.clinicians(id), patient_id text not null references domi.patients(id),
  type text not null, visit_date date not null, start_min int not null, drive int not null default 10,
  status text not null check (status in ('booked','enroute','live','done','missed','cancelled')),
  moved boolean not null default false, seen boolean not null default false, note text, reason text, gap int not null default 0,
  cancelled_at timestamptz, booked_at timestamptz, filled_from text,
  reminded boolean not null default false, cancel_token text unique
);

create table domi.invoices (
  id text primary key, practice_id uuid not null references domi.practices(id),
  number text not null, appointment_id text unique references domi.appointments(id),
  patient_id text not null references domi.patients(id), items jsonb not null, total_pence int not null,
  status text not null default 'unpaid' check (status in ('unpaid','paid','void')), method text,
  issued_at timestamptz not null, paid_at timestamptz,
  unique (practice_id, number)
);

create table domi.waitlist (
  id text primary key, practice_id uuid not null references domi.practices(id),
  patient_id text not null references domi.patients(id), type text not null, prio text not null,
  added_on date not null default current_date, avail text not null default 'any', short_notice boolean not null default true,
  pref_clinician_id text, status text not null default 'waiting' check (status in ('waiting','offered','booked')),
  added_seq int not null default 0, source text not null default 'list' check (source in ('list','recall')), note text
);

create table domi.recalls (
  id text primary key, practice_id uuid not null references domi.practices(id),
  patient_id text not null references domi.patients(id), type text not null, reason text not null,
  due_date date not null,
  status text not null default 'due' check (status in ('due','texted','booked','dismissed')),
  waitlist_id text references domi.waitlist(id), texted_at timestamptz
);

create table domi.offers (
  id bigint generated always as identity primary key, practice_id uuid not null references domi.practices(id),
  slot_id text not null references domi.appointments(id), waitlist_id text not null references domi.waitlist(id),
  status text not null check (status in ('pending','accepted','declined','expired','superseded')),
  score int, round int not null default 1, sent_at timestamptz not null, expires_at timestamptz not null,
  deadline text, booked_appointment_id text
);

create table domi.messages (
  id bigint generated always as identity primary key, practice_id uuid not null references domi.practices(id),
  direction text not null check (direction in ('out','in')), to_name text, phone text, body text not null, kind text not null,
  to_clinician_id text, from_clinician_id text, provider_id text, parts int, read boolean not null default false,
  created_at timestamptz not null default now()
);

create table domi.pcse (
  id bigint generated always as identity primary key, practice_id uuid not null references domi.practices(id),
  action text not null check (action in ('lodge','cancel')),
  patient_id text not null references domi.patients(id), appointment_id text not null references domi.appointments(id),
  visit_date date not null, start_min int not null, status text not null default 'todo' check (status in ('todo','done')),
  created_at timestamptz not null default now(), done_by text
);

create table domi.referrals (
  id text primary key, practice_id uuid not null references domi.practices(id),
  created_at timestamptz not null default now(), status text not null default 'new' check (status in ('new','accepted','declined')),
  from_kind text not null, from_name text, from_phone text,
  name text not null, dob date, addr text not null, pc text not null, phone text, eligibility text not null,
  entitlement jsonb not null default '[]'::jsonb, need text not null, avail text not null default 'any', urgent boolean not null default false,
  notes text, patient_id text references domi.patients(id), decided_by text, decline_reason text
);

create table domi.leads (
  id text primary key, practice_id uuid not null references domi.practices(id),
  created_at timestamptz not null default now(),
  status text not null default 'new' check (status in ('new','contacted','booked','closed')),
  source text not null default 'facebook', campaign text, name text not null, phone text, email text, pc text,
  answers jsonb not null default '[]'::jsonb, note text, handled_by text, handled_at timestamptz,
  patient_id text references domi.patients(id), meta_id text,
  unique (practice_id, meta_id)
);

create table domi.emails (
  id bigint generated always as identity primary key, practice_id uuid not null references domi.practices(id),
  to_addr text not null, to_name text, subject text not null, body text not null, kind text not null,
  lead_id text references domi.leads(id), provider_id text, created_at timestamptz not null default now()
);

-- Every change and every record opened. Append-only: rows can be added, never changed or removed.
create table domi.audit (
  id bigint generated always as identity primary key, practice_id uuid references domi.practices(id),
  ts timestamptz not null default now(), actor text not null, action text not null, entity text, detail text
);
create function domi.audit_is_append_only() returns trigger language plpgsql set search_path = '' as $$
begin raise exception 'the audit log is append-only'; end $$;
create trigger audit_no_change before update or delete on domi.audit
  for each row execute function domi.audit_is_append_only();

create index appointments_day on domi.appointments (practice_id, clinician_id, visit_date, start_min);
create index offers_pending on domi.offers (status, expires_at);
create index patients_practice on domi.patients (practice_id);
create index waitlist_open on domi.waitlist (practice_id, status);
create index recalls_due on domi.recalls (practice_id, status, due_date);
create index messages_practice on domi.messages (practice_id, created_at);
create index leads_practice on domi.leads (practice_id, created_at);
create index audit_practice on domi.audit (practice_id, ts);

-- Belt and braces: row level security on with no policies, so even a misconfigured API key reads nothing.
do $$ declare t text; begin
  for t in select tablename from pg_tables where schemaname = 'domi' loop
    execute format('alter table domi.%I enable row level security', t);
    execute format('revoke all on domi.%I from public, anon, authenticated', t);
  end loop;
end $$;

-- The role the Domi server signs in as. It can log in once a password is set from the dashboard.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'domi_app') then
    create role domi_app nologin bypassrls;
  end if;
end $$;
grant usage on schema domi to domi_app;
grant select, insert, update, delete on all tables in schema domi to domi_app;
revoke update, delete on domi.audit from domi_app;
grant usage, select on all sequences in schema domi to domi_app;

-- Private file storage (logos, imports, invoice PDFs), 20 MB per file.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('practice-files', 'practice-files', false, 20971520, array['image/png','image/jpeg','image/webp','image/svg+xml','application/pdf','text/csv','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'])
on conflict (id) do nothing;
