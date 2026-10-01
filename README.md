# Remote Support Booking

An open-source, self-hostable appointment-request app for small service teams that deliver remote support. Customers ask for a time through an emailed magic link; staff review each request, approve it and assign a technician; everything else happens by email. The support session itself is a phone call plus your remote-access tool of choice (TeamViewer, AnyDesk, and so on). Nothing about the session is stored or brokered by this app, and no remote-access credentials are ever collected.

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

Any other secret manager works the same way, as does a local `.env` file (copy `.env.example`). `scripts/render-wrangler.mjs` reads the environment and renders `wrangler.jsonc` (gitignored) before each dev, test or deploy run.

## Quick start

Requires Node.js 22 or newer.

```bash
cp .env.example .env
npm i
npm run dev      # renders wrangler.jsonc, applies migrations locally, starts Vite
npm run seed     # in another terminal: sample staff, customers and settings
```

Open `http://localhost:5173`. With `MAIL_MODE=dev`, outgoing email is written to a local mailbox instead of being sent; read it at `http://localhost:5173/dev/mail` (this includes the magic links).

Other scripts: `npm test` (Vitest), `npm run typecheck`, `npm run build`, `npm run e2e` (Playwright smoke tests).

Note: `npm run seed` and the `/dev/mail` page are delivered in later development plans; the dev server and tests work today.

## Configuration reference

| Variable | Kind | Example / default |
|---|---|---|
| `APP_DOMAIN` | config | `booking.example.com` (custom-domain route; base URL is `https://APP_DOMAIN`) |
| `ORG_NAME` | config | `Example Support` (initial value; editable in settings afterwards) |
| `MAIL_FROM` | config | `no-reply@booking.example.com` (also the only allowed sender) |
| `MAIL_FROM_NAME` | config | `Example Support` |
| `MAIL_REPLY_FORWARD_TO` | config | Team mailbox for inbound replies (optional) |
| `MAIL_MODE` | config | `cloudflare` (production) or `dev` (local mailbox at `/dev/mail`) |
| `APP_TIMEZONE` | config | `UTC` by default; any IANA timezone, for example `Asia/Tokyo` |
| `APP_LOCALE` | config | `en` |
| `CLOUDFLARE_ACCOUNT_ID` | config | Your Cloudflare account ID |
| `D1_DATABASE_ID` | config | UUID of your D1 database |
| `TURNSTILE_SITE_KEY` | config | Optional |
| `CLOUDFLARE_API_TOKEN` | secret (deploy) | Scoped to Workers Scripts, D1 and Workers Routes on the zone |
| `TURNSTILE_SECRET_KEY` | secret (runtime) | Optional; Turnstile is skipped when unset |
| `BOOTSTRAP_ADMIN_EMAILS` | secret (runtime) | Comma-separated emails that become the first administrators |

Optional: `WORKER_NAME`, `D1_DATABASE_NAME` and `APP_BASE_URL` (local only) override the defaults used when rendering `wrangler.jsonc`. `npm run deploy` renders in strict mode and refuses to continue if a required variable is missing.

## Deployment

See `docs/SETUP.md` for step-by-step deployment (D1, custom domain, email sending domain, Turnstile, first administrator). That guide is written in a later development plan.

## Security notes

- There are no passwords and no signing keys. Magic-link tokens, reservation-access tokens and session IDs are 256-bit random values; only their SHA-256 hashes are stored, and raw tokens are never logged.
- Tokens travel in URL fragments (`#t=...`) and are POSTed by the front end, so they do not reach server logs or `Referer` headers.
- No GET request changes state. Every non-GET API request must carry an `Origin` equal to the app origin and the header `X-Requested-With: fetch`.
- Login and submission endpoints are rate limited, and email-entry forms can be protected with Turnstile.
- Responses carry a strict Content-Security-Policy, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff` and `frame-ancestors 'none'`.
- Outgoing mail can only use the sender allow-listed in the `send_email` binding.
- CI runs [gitleaks](https://github.com/gitleaks/gitleaks) on every push; keep real secrets out of the repository.

## License

MIT. See [LICENSE](LICENSE).
