# Domi Hearing — domiciliary audiology diary (demo)

A working demo of a diary system for a home-visit audiology practice. When a visit is cancelled, the system picks the best patient from the waiting list, texts them an offer, and puts them into the slot when they reply YES. The clinician's phone updates on its own.

"Domi Hearing" is a placeholder name. The patients, phone numbers (Ofcom's reserved drama range) and addresses are invented.

## Run it

Requires **Node 22.5 or newer**. There are no packages to install.

```bash
npm start          # http://localhost:3000
npm test           # unit + API integration tests
```

- App: `http://localhost:3000`
- Technical view: `http://localhost:3000/under-the-hood` (office sign-in only)
- Brand and design tokens: `http://localhost:3000/brand`

Every visitor gets a **private demo**: their own in-memory copy of the sample diary, with a clock that starts at 10:20. To put a phone in the same demo, click **Open on phone** in the office view and scan the QR code.

## Put it online (Render, free)

The repo includes a `render.yaml` Blueprint, so Render reads the settings from the repo.

1. Sign in at [dashboard.render.com](https://dashboard.render.com) with GitHub and give Render access to this repo.
2. **New → Blueprint**, choose this repo and the branch, then **Apply**.
3. Wait about two minutes for the build (it runs the tests) and the start. The link looks like `https://domi-hearing-demo.onrender.com`.

How the free tier behaves:
- **It sleeps after 15 minutes without visits.** The first visit after that takes about a minute to wake it. Open the link a couple of minutes before a meeting.
- **Data resets whenever it wakes or redeploys.** For a demo that's useful: every viewing starts from the same story.
- **Every visitor gets their own private demo**, so people opening the link can't see or break each other's. Demos are cleared after 3 hours idle or when the server sleeps.
- Pages send `noindex`, so search engines won't list it.

## What's in it

| | |
|---|---|
| **Office view** | Every clinician's diary for the day, the waiting list, and every text sent. Cancel any visit to start a refill. |
| **Clinician view** | Phone-first. Today's round with drive times, patient records (alerts, audiogram, aids, history), quick note chips, *On my way* (texts the patient), *Arrived*, *Complete visit*. |
| **Refill engine** | Hard rules: same-day OK, fits the free time, morning/afternoon availability, inside or next to the clinician's area. Ranking: clinical priority, then local, days waiting, preferred clinician. Each candidate shows the reasons. |
| **Offers that respect the clock** | Hours away: one person at a time, with room for several rounds. Under an hour of slack: the top three at once, first YES wins, and the others are told it's gone. Too close to confirm anyone: the slot is left open rather than wasted on someone who can't be ready. |
| **Patients cancel by text** | A patient texting CANCEL cancels today's visit and starts the refill, with no staff involved. In the demo, the office plays the patient's phone. |
| **Book a visit** | Pick a patient (or type in a new one), the visit type and when they're home. The system finds every gap in every round where the visit fits, including the drive in and the drive on to the next patient, and ranks them by the extra driving they add. Booking texts the patient, updates the next visit's drive time and appears on the clinician's phone. If nothing fits, one click puts them on the waiting list. Drive times are estimated from postcode districts (`server/travel.js`). |
| **Income panel** | Recovered income, cancellations refilled, average time to refill and income still unfilled, calculated from the office's own fee per visit. |
| **Live updates** | Server-Sent Events. A cancellation on the laptop appears on the clinician's phone within a second. |
| **Under the hood** | Architecture, the cancellation journey, live API traffic, the event stream, offers, the audit log and a database browser. |

## Architecture

```
public/index.html          Office + clinician app shell; app.js / app.css (vanilla, no build step)
public/brand.html          Logo, colour tokens and type
design/                    Figma build script for the same tokens and logo
public/under-the-hood.html Technical view
server/index.js            HTTP API, auth, static files, SSE, request log
server/service.js          Booking service: transactions, audit, texts, events
server/refill.js           Ranking and offer-planning rules (pure functions, unit tested)
server/sandbox.js          Private demo per visitor + demo clock (AsyncLocalStorage)
server/notify.js           SMS gateway: demo outbox, or real Twilio if keys are set
server/bus.js              Live event fan-out, scoped by role
server/db.js               SQLite schema + seed data (node:sqlite)
test/                      Engine, database and API integration tests
```

Security in the demo: HMAC-signed sessions; per-visitor sandboxes; role checks on every endpoint (a clinician can only open patients on their round or in their patch); validated state transitions; a double-booking guard; texts and live events released only after the database commits; an audit log of every change and every record a person opens; Twilio signature verification on inbound texts; path-traversal-safe static serving. Fonts and libraries are self-hosted, so pages make no third-party requests.

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
| `SESSION_SECRET` | random per start | Set it, or sessions end when the server restarts |
| `MAX_SANDBOXES` | 100 | Private demos kept in memory at once |

## Demo script (5 minutes)

1. On the laptop, sign in as **Sarah Lane (office)**. Click **Open on phone** and scan the QR code: your phone opens as Amira in the same demo.
2. On the laptop, click **Peter Dunn, 11:00** → *Cancel and refill this slot*.
3. Show the ranking and the plan: the visit is 40 minutes away, so the top three are asked at once. Irene is ruled out because she's only free in the afternoons.
4. Reply **NO** as Gerald, then **YES** as Margaret. Sylvia is told it's gone and keeps her place.
5. Hold up the phone. The banner, the new visit and the office's text are already there. The income panel now shows the visit recovered.
6. Click **Ken Ollerton, 13:30** → *Text CANCEL as Ken*. The slot refills with nobody in the office touching it, one patient at a time because there's more time.
7. Click **Book a visit**, choose **Irene Battye** (afternoons only), and find slots. It offers 12:35 with Amira, between Peter and Ken, because that adds the least driving. Book it and show the phone.
8. Open **Under the hood** and show the audit log, the offers table and the database rows that were just written.

## Deliberately out of scope for the demo

Real accounts with two-factor sign-in, UK-hosted Postgres with backups, offline mode for poor signal, a multi-day diary and booking new visits, GP letters, invoicing, Noah/audiometer import, and the data-protection paperwork (DPIA, DSPT).
