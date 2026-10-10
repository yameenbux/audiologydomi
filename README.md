# Domi Hearing — domiciliary audiology diary (demo)

A working demo of a diary system for a home-visit audiology practice. When a visit is cancelled, the system picks the best patient from the waiting list, texts them an offer, and puts them into the slot when they reply YES. The clinician's phone updates on its own.

"Domi Hearing" is a placeholder name. The patients, phone numbers (Ofcom's reserved drama range) and addresses are invented.

## Run it

Requires **Node 22.5 or newer**. There are no packages to install.

```bash
npm start          # http://localhost:3000
npm test           # refill engine unit tests
npm run reset      # wipe the database (it reseeds on next start)
```

- App: `http://localhost:3000`
- Technical view: `http://localhost:3000/under-the-hood` (office sign-in only)

To try it on a phone on the same Wi-Fi, open `http://<your-laptop-ip>:3000`.

## Put it online (Render, free)

The repo includes a `render.yaml` Blueprint, so Render reads the settings from the repo.

1. Sign in at [dashboard.render.com](https://dashboard.render.com) with GitHub and give Render access to this repo.
2. **New → Blueprint**, choose this repo and the branch, then **Apply**.
3. Wait about two minutes for the build (it runs the tests) and the start. The link looks like `https://domi-hearing-demo.onrender.com`.

How the free tier behaves:
- **It sleeps after 15 minutes without visits.** The first visit after that takes about a minute to wake it. Open the link a couple of minutes before a meeting.
- **Data resets whenever it wakes or redeploys.** For a demo that's useful: every viewing starts from the same story.
- **Everyone with the link shares one diary**, and demo sign-in has no passwords. Send the link only to people you're pitching. To reset it by hand, use the Reset button.
- Pages send `noindex`, so search engines won't list it.

## What's in it

| | |
|---|---|
| **Office view** | Every clinician's diary for the day, the waiting list, and every text sent. Cancel any visit to start a refill. |
| **Clinician view** | Phone-first. Today's round with drive times, patient records (alerts, audiogram, aids, history), quick note chips, *On my way* (texts the patient), *Arrived*, *Complete visit*. |
| **Refill engine** | Hard rules: same-day OK, fits the free time, morning/afternoon availability, inside or next to the clinician's area. Ranking: clinical priority, then local, days waiting, preferred clinician. Each candidate shows the reasons. |
| **Two refill modes** | *Text an offer first* (default): the patient replies YES or NO, and no reply within the window moves on to the next person. *Book instantly*: books them and tells them, and they can reply NO. |
| **Live updates** | Server-Sent Events. A cancellation on the laptop appears on the clinician's phone within a second. |
| **Under the hood** | Architecture, the cancellation journey, live API traffic, the event stream, offers, the audit log and a database browser. |

## Architecture

```
public/index.html          Office + clinician app (vanilla JS, no build step)
public/under-the-hood.html Technical view
server/index.js            HTTP API, auth, static files, SSE, request log
server/service.js          Booking service: transactions, audit, texts, events
server/refill.js           Ranking rules (pure functions, unit tested)
server/notify.js           SMS gateway: demo outbox, or real Twilio if keys are set
server/bus.js              Live event fan-out, scoped by role
server/db.js               SQLite schema + seed data (node:sqlite)
test/refill.test.js        Engine tests
```

Security in the demo: HMAC-signed sessions, role checks on every endpoint (a clinician can only open patients on their round or in their patch), validated state transitions (a finished visit can't be restarted), a double-booking guard, an audit log of every change and every record viewed, and path-traversal-safe static serving.

### Sending real texts

```bash
TWILIO_ACCOUNT_SID=... TWILIO_AUTH_TOKEN=... TWILIO_FROM=+44... npm start
```

Point the Twilio number's incoming-message webhook at `https://<host>/api/sms/inbound`. Before going live, add Twilio signature verification to that endpoint (marked in `server/index.js`).

### Settings

| Variable | Default | |
|---|---|---|
| `PORT` | 3000 | |
| `OFFER_MINUTES` | 20 | How long a patient has to reply |
| `SESSION_SECRET` | random per start | Set it, or sessions end when the server restarts |
| `DB_FILE` | `data/domi.sqlite` | |

## Demo script (5 minutes)

1. Sign in on a laptop as **Sarah Lane (office)**. Sign in on your phone as **Amira Shah**.
2. On the laptop, click **Peter Dunn, 11:00** → *Cancel and refill slot*.
3. Show the ranking: Gerald is urgent, Margaret prefers Amira, Irene is ruled out because she's only free in the afternoons.
4. Click **They reply NO** for Gerald. The server offers it to Margaret. Click **They reply YES**.
5. Hold up the phone. The banner, the new visit and the text from the office are already there.
6. On the phone, open Margaret → add a note → **On my way**. Back on the laptop, the text to Margaret appears.
7. Open **Under the hood** and show the audit log, the offers table and the database rows that were just written.

## Deliberately out of scope for the demo

Real accounts with two-factor sign-in, UK-hosted Postgres with backups, offline mode for poor signal, a multi-day diary and booking new visits, GP letters, invoicing, Noah/audiometer import, and the data-protection paperwork (DPIA, DSPT).
