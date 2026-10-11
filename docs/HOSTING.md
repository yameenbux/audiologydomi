# Hosting in the UK

## Why it matters

NHS England's guidance on [off-shoring and public cloud](https://digital.nhs.uk/data-and-information/looking-after-information/data-security-and-information-governance/nhs-and-social-care-data-off-shoring-and-the-use-of-public-cloud-services) says health and care data **must be hosted in the UK**. Hosting in the EEA, an adequate country, or the US under an IDTA is allowed only when:

- the transfer risk is low,
- the organisation's SIRO and executive team approve it, and
- there is a UK GDPR Article 46 risk assessment.

A private practice that takes NHS-funded referrals will be asked about this. Hosting in the UK from day one avoids the question.

Development and test environments can sit outside the UK **as long as they only hold synthetic or test data**. That's why the public demo can stay on Render in Frankfurt: it only holds invented patients. Render has five regions (Oregon, Ohio, Virginia, Frankfurt, Singapore) and none in the UK, so it can't host the real service.

## Options

All of these run the same container (`Dockerfile`) in a London region.

| | Where | Good for | To know |
|---|---|---|---|
| **Fly.io** | `lhr`, London | The quickest move: `fly.toml` is in the repo. Sleeps when idle, so it costs a few pounds a month. | Run one machine while data is in memory. US company, with a DPA available. |
| **AWS** | `eu-west-2`, London | The broadest option: App Runner or ECS for the app, RDS Postgres with automatic backups, KMS encryption. | More to set up and run; it pays off once there are real patients. |
| **Microsoft Azure** | UK South, London | App Service plus Azure Database for PostgreSQL. Familiar to NHS buyers, with published NHS compliance material. | Similar effort to AWS. |
| **Google Cloud** | `europe-west2`, London | Cloud Run (scales to zero) plus Cloud SQL Postgres. | Similar effort to AWS. |
| **DigitalOcean** | LON1, London | App Platform plus Managed Postgres. Simple and predictable pricing. | Fewer compliance documents than the big three. |

My recommendation:

- **For pitching:** Fly.io London. It takes minutes and answers "where is the data?" with "London".
- **For real patients:** AWS `eu-west-2` or Azure UK South, with managed Postgres. It's the choice NHS and enterprise buyers query least.

## Deploying to Fly.io (London)

```bash
fly auth login
fly launch --copy-config --no-deploy   # keeps fly.toml (region lhr)
fly deploy
fly scale count 1                      # the demo keeps data in memory: one machine only
```

The image runs the tests during the build, so a failing test stops a bad deploy. This is the same safety net as Render's `buildCommand: npm test`.

Any other container host works too: `docker build -t domi . && docker run -p 3000:3000 domi`.

## Before real patients

UK hosting is necessary but not enough. The demo deliberately leaves these out:

- **Persistent database.** Data is in memory and resets on restart. Move to managed Postgres in the same London region, encrypted at rest, with daily backups and a restore that has actually been tested.
- **Accounts.** Turn off demo mode (`DEMO_MODE=0`): no shown password, no code helper, no QR sign-in. Each person sets their own password and enrols their own authenticator. Add password reset by email and recovery codes.
- **Sessions.** Already server-side, HttpOnly cookies, idle and absolute timeouts, remote sign-out. With more than one server, move sessions into the database or Redis.
- **Offline copy on phones.** The clinician app keeps today's round and records in the phone's browser storage and wipes it on sign-out. For production, encrypt it with a key held only while signed in, and require a passcode on clinicians' phones (device management).
- **Secrets.** Twilio and database keys go in the host's secret store, never in the repo.
- **Logs.** Keep patient details out of application logs. The audit log stays inside the database.
- **Paperwork:**
  - a DPIA (health data is special category data);
  - ICO registration and a privacy notice;
  - data processing agreements with the host, Twilio and the routing provider;
  - the NHS Data Security and Protection Toolkit if there are NHS contracts;
  - Cyber Essentials, which many NHS buyers ask suppliers for.
- **Routing.** The public OSRM server is fair-use only. Self-host OSRM with the UK map, or use a paid routing API under a DPA. Only postcodes are sent to it, never names.
