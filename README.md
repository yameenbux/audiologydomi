# Domi Hearing — domiciliary audiology diary (demo)

A working demo of a diary system for a home-visit audiology practice. When a visit is cancelled, the system picks the best patient from the waiting list, texts them an offer, and puts them into the slot when they reply YES. The clinician's phone updates on its own.

"Domi Hearing" is a placeholder name. The patients, phone numbers (Ofcom's reserved drama range) and street names are invented. The postcodes are real Leeds postcodes, so the drive times are real.

## Run it

Requires **Node 22.5 or newer**. There are no packages to install.

```bash
npm start          # http://localhost:3000
npm test           # unit + API integration tests
```

- App: `http://localhost:3000`
- Technical view: `http://localhost:3000/under-the-hood` (office sign-in only)
- Brand and design tokens: `http://localhost:3000/brand`

Every visitor gets a **private demo**: their own in-memory copy of the sample practice, with a clock that starts at 10:20. Sign in with a password and then a six-digit code from an authenticator app. In the demo, the sign-in screen shows the password and can fill the code in for you. To put a phone in the same demo, click **Open on phone** in the office view and scan the QR code: it's a one-time sign-in link.

## Put it online

**For a UK-hosted copy**, see [docs/HOSTING.md](docs/HOSTING.md): Fly.io London, using `fly.toml` and the `Dockerfile`, plus the options for real patients and why NHS guidance expects UK hosting.

### Render (free, Frankfurt)

The repo includes a `render.yaml` Blueprint, so Render reads the settings from the repo.

1. Sign in at [dashboard.render.com](https://dashboard.render.com) with GitHub and give Render access to this repo.
2. **New → Blueprint**, choose this repo and the branch, then **Apply**.
3. Wait about two minutes for the build (it runs the tests) and the start. The link looks like `https://domi-hearing-demo.onrender.com`.

How the free tier behaves:
- **It sleeps after 15 minutes without visits.** The first visit after that takes about a minute to wake it. Open the link a couple of minutes before a meeting.
- **Data resets whenever it wakes or redeploys.** For a demo that's useful: every viewing starts from the same story.
- **Every visitor gets their own private demo**, so people opening the link can't see or break each other's. Demos are cleared after 3 hours idle or when the server sleeps.
- Pages send `noindex`, so search engines won't list it.

## Marketing website

`site/` is a one-page website for practices, laid out like the Tidemark site in Domi's colours: a laptop, tablet and phone showing the app, a 22-second film of a cancellation refilling, a deck of cards with each feature, what's built and what's coming, the data promise, searchable questions and the site's privacy policy. It's static, so GitHub Pages hosts it. The app needs a server, so it isn't part of the website: *Try the demo* links to wherever the app runs (Render, above).

- **Preview:** `npm run site`, then open `_site/index.html`.
- **Publish:** `.github/workflows/pages.yml` builds it on every push to `main` that touches the site. Turn it on once under **Settings → Pages → Source: GitHub Actions**.
- **Settings:** optional repository variables (**Settings → Secrets and variables → Actions → Variables**): `DEMO_URL` (default `https://domi-hearing-demo.onrender.com`), `EMAIL` (default `yameen@ysbdesigns.uk`) and `SITE_URL` (default `https://domi.ysbdesigns.uk`, used for link previews and the uptime check).
- **If a deploy says it succeeded but the old page still shows**, GitHub has reused an earlier deployment of the same commit (this happens after switching from "Deploy from a branch"). Push any new commit that touches the site and it publishes properly.
- **Uptime check:** `.github/workflows/site-check.yml` checks the website and the demo every 6 hours. A failed run is the alert.
- **Pictures and film** (`site/shots/`, `site/film/`) are taken from the running demo: the device frames are drawn around real screenshots, and the film is the office screen and a clinician's phone recorded during one refill. Retake them after changing the app's screens.

## What's in it

| | |
|---|---|
| **Office view** | Every clinician's diary for any day this week, a week grid showing how full each round is, the waiting list, and every text sent. Cancel any visit, today or later in the week, to start a refill. |
| **Clinician view** | Phone-first. Today's round with drive times, patient records (alerts, audiogram, aids, history), quick note chips, *On my way* (texts the patient), *Arrived*, *Complete visit*. |
| **Refill engine** | Hard rules: same-day OK, fits the free time, morning/afternoon availability, inside or next to the clinician's area. Ranking: clinical priority, then local, days waiting, preferred clinician. Each candidate shows the reasons. |
| **Offers that respect the clock** | Days or hours away: one person at a time (patients who need 24 hours' notice qualify for later days), with room for several rounds. Under an hour of slack: the top three at once, first YES wins, and the others are told it's gone. Too close to confirm anyone: the slot is left open rather than wasted on someone who can't be ready. |
| **Patients cancel by text** | A patient texting CANCEL cancels today's visit and starts the refill, with no staff involved. In the demo, the office plays the patient's phone. |
| **Book a visit** | Pick a patient (or type in a new one), the visit type and when they're home. The system searches the whole week for every gap in every round where the visit fits, including the drive in and the drive on to the next patient, and ranks them by the extra driving they add, weighed against how soon it is (urgent patients are pulled towards sooner days, routine ones towards less driving). Booking texts the patient, updates the next visit's drive time and appears on the clinician's phone. If nothing fits, one click puts them on the waiting list. Drive times are road routes between full postcodes (see *Drive times* below). |
| **Income panel** | Recovered income, cancellations refilled, average time to refill and income still unfilled, calculated from the office's own fee per visit. |
| **Day-before reminders** | Every visit tomorrow gets a reminder text at the practice's reminder time (17:00 by default, or *Send now* in the Reminders panel). A CANCEL reply cancels that visit and starts the refill a day ahead. |
| **Route map** | Each clinician's day on a map: numbered stops, drive minutes per leg, the drive home, and totals. It's drawn from coordinates, so it needs no map service and works offline. In booking, *Map* shows where a proposed visit would fit. |
| **Patient booking page** | `/book/<practice code>`: patients choose a time themselves, with large text and one question at a time. It only offers times from tomorrow that add 20 minutes of driving or less, and never shows other patients' details. Fittings stay with the office. |
| **Recalls** | Patients due a review (annual review, 6-month check, wax recheck) join the refill pool, so a cancellation near them is offered to someone due anyway. The office can text them the booking page. |
| **Mileage & utilisation** | For each clinician and day: time booked against the working day, driving time, estimated miles and their value at HMRC's 45p rate. Downloads as CSV for mileage claims. |
| **Invoicing** | Completing a visit raises an invoice at the practice's price for that visit type (£0 = none). The office marks invoices paid by card, cash or bank transfer, voids them, or prints them. No VAT is added: check your VAT treatment with an accountant. |
| **Offline clinician app** | A service worker keeps the app on the phone. Today's round and its records are saved on the device, and notes and visit updates made without signal are queued and synced in order when it returns. Signing out wipes the copy. Office screens don't keep one. |
| **Sign-in** | Email and password (scrypt-hashed), then a six-digit code from any authenticator app (TOTP, RFC 6238). Codes can't be reused. Accounts lock after 5 wrong passwords. Sessions are server-side, in an HttpOnly cookie, and end after 2 hours idle or 12 hours. The office can view the app as any clinician (audited), see every signed-in device, and sign a lost phone out remotely. |
| **Live updates** | Server-Sent Events. A cancellation on the laptop appears on the clinician's phone within a second. |
| **What's coming** | Features not built yet sit where they'll live, with a *Soon* badge: Noah import and AI notes in the patient record, card payments, Xero and care-home billing in Invoices, automatic recall texts, stock and repairs, data import, password reset and native apps. Clicking one says what it will do and that it's not in the demo. *What's coming* lists them all, split into next and later, with no dates. The list is `ROADMAP` in `public/app.js`. |
| **Under the hood** | Architecture, the cancellation journey, live API traffic, the event stream, offers, the audit log and a database browser. |

## Architecture

```
public/index.html          Office + clinician app shell; app.js / app.css (vanilla, no build step)
public/brand.html          Logo, colour tokens and type
design/                    Figma build script for the same tokens and logo
public/under-the-hood.html Technical view
server/index.js            HTTP API, sign-in routes, static files, SSE, request log
server/auth.js             Passwords (scrypt), two-factor codes (TOTP), sessions, phone pairing links
server/service.js          Booking service: transactions, audit, texts, events
server/refill.js           Ranking and offer-planning rules (pure functions, unit tested)
server/sandbox.js          Private demo per visitor + demo clock (AsyncLocalStorage)
server/notify.js           SMS gateway: demo outbox, or real Twilio if keys are set
server/travel.js           Postcode lookup + road drive times (postcodes.io, OSRM), cached, with fallback
server/bus.js              Live event fan-out, scoped by role
server/db.js               SQLite schema + seed data (node:sqlite)
test/                      Engine, database and API integration tests
```

Security in the demo:

- **Sign-in:** two-step sign-in (password plus authenticator code) with lockout and per-connection limits; server-side sessions with remote sign-out; CSRF protection (an app-only header plus an Origin check); secrets hidden even from the database browser.
- **Isolation:** per-visitor sandboxes.
- **Access:** role checks on every endpoint (a clinician can only open patients on their round or in their patch).
- **Data integrity:** validated state transitions; a double-booking guard; texts and live events released only after the database commits.
- **Audit:** a log of every change and every record a person opens.
- **Inbound texts:** Twilio signature verification.
- **Static files:** path-traversal-safe serving. Fonts and libraries are self-hosted, so pages make no third-party requests.

### Drive times

Each booking option is labelled **Road route** or **Estimated**.

- **Postcodes** are placed with [postcodes.io](https://postcodes.io), which is free and uses Ordnance Survey and ONS data.
- **Road driving times** come from an [OSRM](https://project-osrm.org) table request covering every stop in the diary. Each time has 30% added for daytime traffic and 4 minutes for parking.
- **Caching and fallback:** results are cached. Requests time out after 3 seconds, and after a failure the router is left alone for a minute. Until it's back, estimates from straight-line distance are used, so booking never waits on a third party.
- **The sample diary** uses road times saved from OSRM (`server/routes-seed.json`), so it shows real routes even offline.
- **When it's on:** live lookups need `ROUTING_PROVIDER=osrm`, which `render.yaml` sets. Locally and in the tests, new postcodes are estimated.

For production, swap the public OSRM demo server (fair use only, no traffic data) for a self-hosted OSRM with the UK map, or a paid service with live traffic (Google Routes, TomTom, Mapbox). Only `server/travel.js` changes.

### Sending real texts

```bash
TWILIO_ACCOUNT_SID=... TWILIO_AUTH_TOKEN=... TWILIO_FROM=+44... npm start
```

Point the Twilio number's incoming-message webhook at `https://<host>/api/sms/inbound`. That endpoint only exists when Twilio is configured, and it rejects any request without a valid `X-Twilio-Signature` (it uses `PUBLIC_URL`, or `RENDER_EXTERNAL_URL` on Render).

### Settings

| Variable | Default | |
|---|---|---|
| `PORT` | 3000 | |
| `OFFER_MINUTES` | 20 | How long a patient has to reply |
| `DEMO_MODE` | `1` | `0` removes the demo shortcuts: no password on screen, no code helper, no QR sign-in |
| `MAX_SANDBOXES` | 100 | Private demos kept in memory at once |
| `ROUTING_PROVIDER` | `estimate` | `osrm` for live road routes and postcode lookups |
| `OSRM_URL` | public demo server | Your own OSRM server |

## Demo script (about 8 minutes)

1. On the laptop, click **Sarah Lane (office)**. That fills in her email and password and takes you to the code step. Click **Fill in the current code**, then **Verify**. (Or scan the QR there with Google or Microsoft Authenticator and type the real code.) Click **Open on phone** and scan the QR code: your phone signs in as Amira in the same demo.
2. On the laptop, click **Peter Dunn, 11:00** → *Cancel and refill this slot*.
3. Show the ranking and the plan: the visit is 40 minutes away, so the top three are asked at once. Irene is ruled out because she's only free in the afternoons.
4. Reply **NO** as Gerald, then **YES** as Margaret. Sylvia is told it's gone and keeps her place.
5. Hold up the phone. The banner, the new visit and the office's text are already there. The income panel now shows the visit recovered.
6. Click **Ken Ollerton, 13:30** → *Text CANCEL as Ken*. The slot refills with nobody in the office touching it, one patient at a time because there's more time.
7. Click **Book a visit**, choose **Irene Battye** (afternoons only), and find slots. It offers 12:35 today with Amira, between Peter and Ken, and later options across the week. Book it and show the phone.
8. Click **Week** to show how full each round is this week. Open Thursday and cancel a visit: with days to spare, it asks one person at a time.
9. Click the pin on Amira's column to show her route map. In **Reminders**, click *Send now*, then reply CANCEL as one of tomorrow's patients: the slot refills a day ahead.
10. Click **Patient booking page**, open it on the phone and book a visit as a patient. The office sees it arrive.
11. On the phone, turn on airplane mode, complete a visit and add a note, then turn signal back on: both sync. Open **Invoices** to show the invoice that completing the visit raised.
12. Click **What's coming** to show what's planned, and that nothing on the list pretends to work yet.
13. Open **Under the hood** and show the audit log, the offers table and the database rows that were just written.

## Deliberately out of scope for the demo

Persistent UK-hosted Postgres with backups (see [docs/HOSTING.md](docs/HOSTING.md)), password reset and per-person authenticator enrolment, encrypted storage for the offline copy on the phone, recurring visits and diaries beyond this week, GP letters, stock and repairs, an AI note-writer, Noah/audiometer import, and the data-protection paperwork (DPIA, DSPT).
