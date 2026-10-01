# Remote Support Booking

An open-source, self-hostable appointment-request app for small service teams that deliver remote support. Customers ask for a time through an emailed magic link; staff review each request, approve it and assign a technician; everything else happens by email. The support session itself is a phone call plus your remote-access tool of choice (TeamViewer, AnyDesk, and so on). Nothing about the session is stored or brokered by this app, and no remote-access credentials are ever collected.

## Status

Under active development; not production-ready yet. The feature list below describes the finished app.

Implemented now (core flow):

- Customer magic-link sign-in for registered contacts, slot availability with technician-aware capacity (business hours, holidays, buffers, minimum notice) and atomic, idempotent booking requests that hold a technician.
- Staff magic-link sign-in, request dashboard and detail, approval with technician assignment (moving other pending requests when needed) and decline with a reason.
- Customer "My reservations" and per-reservation access links from emails.
- An administrator switch on the staff dashboard pauses and resumes online booking (to stop spam); existing reservations, their links and all staff features keep working.
- Email outbox with retries for every notification, a local development mailbox, audit log entries, rate limits and optional Turnstile.

Planned:

- Administration: staff scheduling (weekly patterns, date overrides, technician unavailability), customer administration with CSV import, staff management and settings. Until then, `npm run seed` creates sample data locally.
- Lifecycle: cancellation, rescheduling proposals, approval reminders, escalation and expiry, customer reminders, completion and `.ics` export.
- Deployment: automated first deployment, runtime secrets and the remaining steps in `docs/SETUP.md`.

## Who it is for

Small technical-service teams (IT support, equipment vendors, clinics' IT providers and similar) that:

- support a known list of customers rather than the general public;
- want a human to approve each appointment instead of instant self-service booking;
- have a few technicians whose availability and capacity must be respected;
- would rather run one small Cloudflare deployment than a stack of services.

## Features

- Eligible-customer magic-link access: no passwords, no public self-registration.
- Slot booking with technician-aware capacity, business hours, holidays, buffers and minimum notice.
- Staff approval and technician assignment, with reminders, escalation and automatic expiry of unanswered requests.
- Rescheduling proposals: staff offer alternative times and the customer picks one by email.
- Cancellation by customers and staff, with a configurable cut-off.
- Customer reminders by email before the appointment.
- Staff scheduling: weekly patterns, date overrides and technician unavailability.
- Customer administration with CSV import (see `docs/sample-customers.csv`) and staff management.
- Audit log of every state change.
- Email outbox with retries and a failure banner for staff.
- `.ics` calendar export for confirmed reservations.
- English UI and emails through an i18n catalog.

Out of scope: payments, subscriptions, AI features, CRM features, remote-access tool APIs, meeting links, Outlook/Graph integration, calendar subscriptions and public self-registration.

## How it works

```
customer ──► request a time (magic link, email-verified)
                 │
                 ▼
         PENDING  (capacity is held for the requested slot)
                 │  staff get notified; reminders and escalation run on a timer
                 ▼
     approve + assign technician        propose another time      decline / expire
                 │                              │                       │
                 ▼                              ▼                       ▼
         CONFIRMED  ◄── customer accepts ── proposal sent         customer notified
                 │
                 ▼
     reminders by email  ──►  phone call + remote-access session  ──►  completed
```

A request holds technician capacity from the moment it is submitted, so two customers can never take the same technician for overlapping times. Staff can reassign, cancel or reschedule at any point, and each change is announced by email.

## Tech stack

The whole app runs on Cloudflare: one Worker serves the API and the static front end, and D1 holds all data.

| Layer | Choice |
|---|---|
| Frontend | React + Vite (served as Workers Static Assets) |
| Backend | Cloudflare Workers + Hono |
| Database | Cloudflare D1 |
| Email | Cloudflare Email Service (`send_email`) + Email Routing for replies |
| Scheduled jobs | Workers Cron Triggers |
| Bot protection | Cloudflare Turnstile |
| Domain | Workers custom domain |

Also used: React Router, TanStack Query, Tailwind CSS v4, Zod, `date-fns` with `@date-fns/tz`, and Vitest with `@cloudflare/vitest-pool-workers` for tests that run against real workerd and D1.

## Configuration & secrets

Every deployment-specific value and every secret is supplied through environment variables. Nothing organisation-specific is committed to this repository. The reference deployment keeps them in [Doppler](https://www.doppler.com/) and deploys with:

```bash
doppler run -- npm run deploy
```

Any other secret manager works the same way. For local development, copy `.env.example` to `.env` (its values are local-only placeholders, and `MAIL_MODE=dev` there is refused by the deploy). `scripts/render-wrangler.mjs` reads the environment (and `.env`, without overriding real variables) and renders `wrangler.jsonc` (gitignored) before each dev, test or deploy run.

## Quick start

Requires Node.js 22 or newer.

```bash
cp .env.example .env
npm i
npm run dev      # renders wrangler.jsonc, applies migrations locally, starts Vite
npm run seed     # in another terminal: sample staff, customers and a weekly schedule
```

Open `http://localhost:5173`. With `MAIL_MODE=dev`, outgoing email is written to a local mailbox instead of being sent; read it at `http://localhost:5173/dev/mail` (this includes the magic links).

Other scripts: `npm test` (Vitest), `npm run test:scripts` (Node tests for the config renderer), `npm run typecheck`, `npm run build`, `npm run e2e` (Playwright smoke tests).

The seed is synthetic and idempotent: staff `admin@example.test` and `tech1@`–`tech3@example.test`, the customers in `docs/sample-customers.csv` (e.g. `frontdesk@example.test`) and Mon–Fri 09:00–12:00 / 13:00–17:00. Staff sign in at `http://localhost:5173/staff/login`. `npm run e2e` starts (or reuses) the dev server on port 5173 and runs `npm run seed -- --reset` first, which also clears local reservations, emails, sessions and rate-limit counters.

## Configuration reference

| Variable | Kind | Example / default |
|---|---|---|
| `APP_DOMAIN` | config | `booking.example.com` (custom-domain route; base URL is `https://APP_DOMAIN`) |
| `ORG_NAME` | config | `Example Support` (initial value; editable in settings afterwards) |
| `MAIL_FROM` | config | `no-reply@booking.example.com` (also the only allowed sender) |
| `MAIL_FROM_NAME` | config | `Example Support` |
| `MAIL_REPLY_FORWARD_TO` | config | Team mailbox for inbound replies (optional) |
| `MAIL_MODE` | config | `cloudflare` (required for deployments) or `dev` (local mailbox at `/dev/mail`, localhost only) |
| `APP_TIMEZONE` | config | `UTC` by default; any IANA timezone, for example `Asia/Tokyo` |
| `APP_LOCALE` | config | `en` |
| `CLOUDFLARE_ACCOUNT_ID` | config | Your Cloudflare account ID |
| `D1_DATABASE_ID` | config | UUID of your D1 database |
| `TURNSTILE_SITE_KEY` | config | Optional |
| `CLOUDFLARE_API_TOKEN` | secret (deploy) | Custom token with the account and zone permissions listed in `docs/SETUP.md` |
| `TURNSTILE_SECRET_KEY` | secret (runtime) | Optional; Turnstile is skipped when unset |
| `BOOTSTRAP_ADMIN_EMAILS` | secret (runtime) | Comma-separated emails that become the first administrators |

Optional: `WORKER_NAME`, `D1_DATABASE_NAME` and `APP_BASE_URL` (local only) override the defaults used when rendering `wrangler.jsonc`. `npm run deploy` renders in strict mode and refuses to continue if a required variable is missing.

## Deployment

See [`docs/SETUP.md`](docs/SETUP.md) for the Cloudflare API token, the configuration values and how to keep them in a secret manager. Step-by-step instructions for the remaining pieces (D1, custom domain, email sending domain, Turnstile, first administrator) are added there as deployment support lands.

`npm run deploy` renders `wrangler.jsonc` with `--strict`, which refuses to continue when a required value is missing, when `MAIL_MODE` is not `cloudflare` (including a `dev` value picked up from a local `.env`), when the account or D1 ID is all zeros, or when a value is still a `REPLACE_ME…`/`SET_BY…` placeholder.

## Security notes

- There are no passwords and no signing keys. Magic-link tokens, reservation-access tokens and session IDs are 256-bit random values; only their SHA-256 hashes are stored, and raw tokens are never logged.
- Tokens travel in URL fragments (`#t=...`) and are POSTed by the front end, so they do not reach server logs or `Referer` headers.
- No GET request changes state. Every non-GET API request must carry an `Origin` equal to the app origin and the header `X-Requested-With: fetch`.
- Login and submission endpoints are rate limited, and email-entry forms can be protected with Turnstile.
- The front end is served with a strict Content-Security-Policy from `public/_headers`: scripts, styles, fetches and images from the app's own origin only (no inline scripts or styles), Cloudflare Turnstile as the only third-party script and frame, no plugins, `frame-ancestors 'none'`. It also sends `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff` and a `Permissions-Policy` that turns off camera, microphone and geolocation. Only `/dev/*` (the local development mailbox, which previews emails with inline styles) allows inline styles.
- API responses carry `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff` and `Cache-Control: no-store`.
- The development mailbox (`MAIL_MODE=dev`) works only when `APP_BASE_URL` is `localhost` or `127.0.0.1`; anywhere else its route answers 404 and sending mail fails with a configuration error instead of writing to the local mailbox.
- Outgoing mail can only use the sender allow-listed in the `send_email` binding.
- CI runs [gitleaks](https://github.com/gitleaks/gitleaks) on every push; keep real secrets out of the repository.

## License

MIT. See [LICENSE](LICENSE).
