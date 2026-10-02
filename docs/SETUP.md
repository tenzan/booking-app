# Deployment setup

This guide covers what a deployment needs outside the code: a Cloudflare API token, the configuration values, and where to keep them. Full deployment steps (D1, custom domain, Email Service, Turnstile, CI) are added as the remaining parts of the project land.

Throughout, `booking.example.com` stands for your app's hostname and `example.com` for the zone it lives in.

## 1. Cloudflare API token

Create a dedicated token for this app: **Cloudflare dashboard → My Profile → API Tokens → Create Token → Custom token**. Name it e.g. `remote-support-booking-deploy`.

| Scope | Permission | Access | Used for |
|---|---|---|---|
| Account | Workers Scripts | Edit | Deploy the Worker, set runtime secrets |
| Account | D1 | Edit | Create the database, apply migrations |
| Account | Turnstile | Edit | Create the bot-protection widget |
| Account | Email Sending (may be labelled "Email Service") | Edit | Onboard the app hostname for sending |
| Account | Account Settings | Read | Wrangler account lookups |
| Account | Workers Tail | Read | Live logs (optional) |
| Zone | Zone | Read | Look up the zone |
| Zone | DNS | Edit | App hostname and email DNS records |
| Zone | Workers Routes | Edit | Attach the custom domain to the Worker |

- **Account Resources:** include only your account.
- **Zone Resources:** *Specific zone* → the zone that will host the app hostname.
- **Client IP filtering:** leave off if you deploy from CI (GitHub Actions IPs change).

If you prefer not to grant the Email Sending permission, you can instead onboard the app hostname for sending by hand in the dashboard (Email section) before the first deploy. Inbound routing ("Receiving replies" in section 4) is always configured by hand; the token needs no Email Routing permission.

> **Mail on your apex domain is not touched.** Sending and inbound routing are configured on the app hostname (e.g. `booking.example.com`) only. Never run the zone-level Email Routing wizard on the apex of a domain whose mail is hosted elsewhere — it proposes replacing the apex MX/SPF records.

## 2. Configuration values

Every deployment-specific value is an environment variable. Nothing organisation-specific is committed to the repository. `scripts/render-wrangler.mjs --strict` builds `wrangler.jsonc` from these at deploy time and refuses to run if a required value is missing or still a placeholder (all-zero IDs, `REPLACE_ME…`, `SET_BY…`), or if `MAIL_MODE` is anything other than `cloudflare`.

| Variable | Kind | Example | Notes |
|---|---|---|---|
| `CLOUDFLARE_API_TOKEN` | secret (deploy) | — | Token from section 1 |
| `CLOUDFLARE_ACCOUNT_ID` | config | `0123…` | Dashboard → Workers & Pages → Account ID |
| `APP_DOMAIN` | config | `booking.example.com` | Custom domain for the Worker |
| `APP_TIMEZONE` | config | `Asia/Tokyo` | IANA zone used for schedules and display |
| `APP_LOCALE` | config | `en` | |
| `ORG_NAME` | config | `Example Support` | Initial value; editable later in Settings |
| `MAIL_MODE` | config | `cloudflare` | Must be `cloudflare` in production (`dev` writes to a local mailbox) |
| `MAIL_FROM` | config | `no-reply@booking.example.com` | Must be on the onboarded app hostname |
| `MAIL_FROM_NAME` | config | `Example Support` | Display name |
| `BOOTSTRAP_ADMIN_EMAILS` | secret (runtime) | `admin@example.com` | First administrator(s); inert once an admin exists |
| `WORKER_NAME` | config | `remote-support-booking` | Optional |
| `D1_DATABASE_NAME` | config | `remote-support-booking` | Optional |
| `D1_DATABASE_ID` | config | `xxxxxxxx-…` | From `wrangler d1 create` |
| `TURNSTILE_SITE_KEY` | config | `0x4AAA…` | Optional; enables bot protection |
| `TURNSTILE_SECRET_KEY` | secret (runtime) | — | Optional; pairs with the site key |

## 3. Keeping the values in a secret manager

The reference deployment keeps all of the above in **[Doppler](https://www.doppler.com/)** — one project with a `dev` config (safe local values) and a `prd` config (real values) — and injects them at deploy time:

```bash
doppler setup --project <your-project> --config prd
doppler secrets set CLOUDFLARE_API_TOKEN          # prompts for the value; never paste tokens into shell history
doppler run -- npm run deploy
```

Any other secret manager works the same way as long as the variables reach the deploy process. For local development, `cp .env.example .env` is enough — no Cloudflare credentials are needed to run the app and its tests locally.

## 4. First deployment

With the values from section 2 available in your environment (for example via `doppler run --`):

```bash
npx wrangler d1 create <database-name>        # put the printed id into D1_DATABASE_ID
doppler run -- npm run deploy
```

`npm run deploy` renders the production `wrangler.jsonc` (refusing dev mail mode and placeholder values), builds the app, applies D1 migrations to the remote database, deploys the Worker to `APP_DOMAIN` as a custom domain (Cloudflare creates the DNS record and certificate; the `*.workers.dev` URL is disabled), and finally pushes the runtime secrets (`TURNSTILE_SECRET_KEY`, `BOOTSTRAP_ADMIN_EMAILS`) with `wrangler secret bulk`.

**Email sending:** in the Cloudflare dashboard, open **Email Service → Sending → Add domain** and add your app hostname (e.g. `booking.example.com`). The records it creates live on that hostname and its own bounce subdomain; nothing on your apex domain changes. Until this is done, emails stay in the outbox and are retried; failed ones can be retried from the staff area.

**Receiving replies:** customers can answer the app's emails; the Worker relays each reply to every active team member who receives new-request emails (Team → "New-request emails"), with Reply-To set to the customer so staff simply reply. In the Cloudflare dashboard:

1. Open **Email → Email Routing** for the zone and enable it **for the app hostname only** (e.g. `booking.example.com`, added as a subdomain), not for the apex.
2. Add a routing rule for the sender address (`MAIL_FROM`, e.g. `no-reply@booking.example.com`), or a catch-all for that hostname, with the action **Send to a Worker** and this Worker as the destination.

The Worker accepts mail only for addresses at `MAIL_FROM`'s domain, rejects messages over 1 MB, silently drops automatic mail (auto-replies, bounces and delivery reports, mailing-list and bulk mail, `no-reply`/`mailer-daemon`/`bounce` style senders, anything from an address at your own domain) and accepts at most 20 messages an hour per sender and, as a global ceiling, 200 an hour in total (messages over a limit are dropped, which also bounds the mail a flood can make the Worker send to your team). The relayed email shows the sender's address, clearly marked as not verified (anyone can forge a From address, so treat a reply as a message to read, not as proof of who wrote it), and quotes their text; it is sent with `Auto-Submitted: auto-generated` and `X-Auto-Response-Suppress: All` when the Cloudflare binding accepts custom headers (otherwise it is sent without them). It never replies to the sender and never forwards attachments (the staff email says how many there were). If the reply mentions a reservation reference (`R-XXXX-XXXX`), the staff email links to that reservation. Until a rule is in place, replies to the app's emails bounce or go nowhere.

> **Do not run the Email Routing wizard on the apex.** For a domain whose mail is hosted elsewhere, the zone-level wizard proposes replacing the apex MX and SPF records and would break that mail. Only the app hostname is configured here.

**First administrator:** open `https://APP_DOMAIN/staff/login` and request a link with an address listed in `BOOTSTRAP_ADMIN_EMAILS`.

## 5. Continuous deployment (GitHub Actions)

`.github/workflows/deploy.yml` deploys every push to `main` after typecheck and tests. It reads all configuration from Doppler at run time and needs one repository secret:

```bash
doppler configs tokens create github-actions --project <your-project> --config prd --plain \
  | gh secret set DOPPLER_TOKEN --repo <owner>/<repo>
```

Without that secret the deploy job is skipped, so forks of this repository stay green.

After deploying, the workflow runs the smoke test (`node scripts/smoke.mjs "https://$APP_DOMAIN" --wait 60`, with `APP_DOMAIN` from Doppler; see section 11), and the job fails if a check fails. On the very first deployment the custom domain's DNS record and certificate can take a few minutes: `--wait 60` makes the script poll `/api/health` (6 tries, 10 seconds apart) before checking, but if the site is still not up after that the smoke test fails: re-run the workflow once the site loads. The smoke step is limited to 5 minutes.

## 6. Importing customers

Administrators can import customers from a CSV file in the staff area (Customers → Import CSV; columns `customer_number,name,phone,contact_email,contact_name,active`; see `docs/sample-customers.csv`). Each row is one contact; rows with the same `customer_number` form one customer. The import only creates and updates: it never deletes customers or contacts, and a blank `phone`, `contact_name` or `active` leaves the stored value as it is. A file may have up to 5000 rows and 1 MB.

The import page offers `docs/sample-customers.csv` for download at `/samples/customers.csv`. That file is the only copy: a small plugin in `vite.config.ts` serves it from the dev server and adds it to the client build, so edit it in `docs/` (the dev seed reads it too).

The import is written to D1 in batches of at most 100 statements, and every batch is one request from the Worker to D1. A large file therefore needs the **Workers Paid plan's subrequest allowance**; on the free plan (50 subrequests per request) keep files under about 1000 rows, or split them. If an import stops part way, importing the same file again finishes it safely.

## 7. Initial data

A new deployment starts empty: no staff, no customers and no weekly hours, so nobody can book yet. Set it up in this order from the staff area (`https://booking.example.com/staff`):

1. **First administrator.** Open `/staff/login` and request a sign-in link with an address listed in `BOOTSTRAP_ADMIN_EMAILS` (section 2). While there is no active administrator, that address becomes one when it asks for a link; once an administrator exists the setting has no effect (it only recovers access if every administrator has been deactivated). The new administrator is named after the address and takes bookings: rename them, or turn off "Takes bookings", in **Team**.
2. **Team.** In **Team → Add a team member**, add each technician (and any further administrators) with their work email. Each signs in with a link sent to that address. "Takes bookings" decides who can be assigned to appointments; "New-request emails" decides who is told about new requests.
3. **Weekly schedule.** In **Schedule → Weekly**, add the hours customers can book on each weekday and choose the technicians who work them (**Add hours**). Close single dates or give them other hours under **Dates**, add public holidays in **Settings → Holidays**, and record time off under **Time off**. Customers only see times when a technician on the schedule is free.
4. **Customers.** Import your customers in **Customers → Import CSV** (see section 6 for the columns and rules; a sample file is offered at `/samples/customers.csv`), or add them one by one in **Customers**. Only the contacts listed there can request a booking link.
5. **Settings.** In **Settings**, check the organisation name and set the **Support phone**: customers see it while online booking is paused and on their reservation page. Review the appointment length, buffers, booking window and business hours.
6. **Online booking.** Online booking is on unless an administrator has paused it. If you paused it while setting up (with the switch in **Settings → Online booking** or on the staff dashboard), resume it there now. You can pause it again at any time, for example to stop a wave of spam requests: customers then see a notice with your support phone, while existing reservations, their email links and all staff features keep working.

To try the app with sample data on your own machine instead, see "Quick start" in the README (`npm run seed`).

**How schedule changes judge existing appointments.** Before a schedule change is saved, the app lists the appointments and requests it would affect. An appointment counts as covered by a weekly or date window when its **start time** falls inside the window and its technician is on it (and not on time off during the appointment, buffers included). Shortening the end of a window therefore does not flag an appointment that starts inside it but runs past the new end; check those yourself in the calendar if that matters to you. When a change takes a technician away from an appointment, the dialog offers the technicians who can take it under the new schedule: choosing one stages the reassignment, and it is saved together with the change.

## 8. Deploying schema changes

`npm run deploy` applies D1 migrations to the remote database **before** it uploads the new Worker, so for a short while the previous release runs against the new schema (and if the deploy fails after the migrations, it keeps doing so). Keep every migration backward-compatible with the previous release: add tables, nullable columns or columns with defaults; do not drop or rename columns the running code still reads, and do not add constraints or triggers that the previous release's writes would violate. Make enforcing changes one release later — for example, ship the code that always fills a new column first, then add the trigger or `NOT NULL` rebuild that enforces it in the next release.

## 9. Reminders and deadlines

A Cron Trigger runs the Worker every minute (the schedule is in the rendered `wrangler.jsonc`; nothing to configure on Cloudflare). Each run does the following, then sends whatever mail that queued. The sweeps handle at most 50 rows per kind and the hourly cleanup at most 1000 rows per table, so a backlog drains over the next runs:

- **Expires unanswered requests.** A pending request that reaches its deadline is closed as expired, its technician hold is released and the customer and the team are told.
- **Reminds and escalates.** Before the deadline, the people who receive new-request emails get one reminder, and the administrators one escalation, for each request still waiting. A request with an open rescheduling proposal is not reminded: staff are already acting on it.
- **Expires proposals** the customer has not answered (see "Rescheduling" below) and tells both sides.
- **Completes appointments.** A confirmed appointment whose end has passed becomes completed (no email).
- **Stays quiet about stale news.** A request whose requested time has already passed, or whose deadline is more than 24 hours ago, is still expired (and its hold released) but nobody is emailed; the same goes for a proposal whose offered times have all passed or that expired more than 24 hours ago. This only happens after the cron has not run for a while (an outage, or rows left from before this release); the activity log notes that nobody was emailed.
- **Cleans up, once an hour.** Expired sign-in and access tokens and ended sessions after a week, rate-limit counters after a day, delivered mail after 90 days (failed mail stays until an administrator deals with it) and the development mailbox after a week.

Customer reminders for a confirmed appointment (for example 24 hours and 1 hour before it) are queued when the appointment is confirmed (approved by staff, or a proposed time accepted by the customer) and sent by the outbox at the right time; moving or cancelling the appointment withdraws the ones not yet sent. Appointments confirmed before you upgrade to the release that added reminders get none: only appointments confirmed afterwards are reminded.

All of this is configurable in **Settings** (administrators only):

| Setting (section) | Default | Meaning |
|---|---|---|
| Remind the team after (Approval deadlines) | 2 business hours | Counted from when the request came in; business hours and holidays are those of Settings → Business hours and Holidays |
| Escalate after (Approval deadlines) | 4 business hours | Sent to the administrators |
| Expire unanswered requests after (Approval deadlines) | 8 business hours | The request expires at this deadline, or this long before its start if that comes first |
| ...or this long before the start (Approval deadlines) | 60 minutes | Whichever comes first. The reminder and escalation always come at least 30 minutes before the expiry |
| Reminder times (Customer reminders) | 24 hours and 1 hour before | Up to three, before a confirmed appointment |
| Cancellation cutoff (Appointments) | 60 minutes | Customers can cancel online until this long before the start; staff can always cancel |

Settings changes apply to requests made afterwards: a request keeps the deadlines it was given when it came in.

## 10. Rescheduling

**Proposals.** On a pending request or a confirmed appointment, staff can choose **Propose another time** and offer the customer one to three other times, each with its technician. Every offered time is held for its technician while the proposal is open, so a time that was offered cannot be booked by someone else in the meantime; the original keeps its own hold too. The customer receives an email and picks one time (which makes the appointment confirmed at that time with that technician, with one "rescheduled" email) or asks for a different time. Keeping the original time is offered only for a confirmed appointment: for a pending request the proposal means the requested time can't be given, so the customer sees the offered times and "Choose another time". A new proposal replaces the open one, and staff can withdraw a proposal, which releases its times and tells the customer the original stands.

**Expiry.** An unanswered proposal expires at the earlier of: the proposal-expiry setting (**Settings → Rescheduling**, default 24 business hours) after it was made, and a set time before the current appointment starts (default 120 minutes). It also lapses an hour before the earliest time it offers. No new proposal can be made once the appointment is closer than that second value. When a proposal expires its held times are released, the customer and the team are told, and the original time stands. A pending request's approval deadline was moved out to the proposal's expiry while the proposal was open (so it cannot expire while the customer is deciding), and it is not moved back: the normal expiry then handles the request.

**Replacement requests ("choose another time").** A customer who wants a different time than the ones offered, or for an appointment they already have, chooses another time themselves. That creates a new pending request that replaces the original; the original keeps its time and technician until staff approve the replacement. Approving it (or the customer accepting a proposal on it) cancels the original in the same step, frees its time and sends one "rescheduled" email instead of a cancellation. If staff decline the replacement or it expires, the original is unaffected. A customer has at most one pending replacement per appointment, and an open proposal on the original is closed when the replacement is made. While a replacement is pending, staff can't propose times on the original: they approve or decline the replacement instead. Cancelling the original (by the customer or staff) cancels its pending replacement too, with one cancellation email; if a pending original expires, its replacement stays pending as a request of its own.

Customers can also add a confirmed appointment to their calendar (`.ics` download) from their reservation page, and staff from the request page.

## 11. Operations

### Logs

Observability is enabled in the rendered `wrangler.jsonc`, so the Worker's logs and invocations are kept by Cloudflare. To see them:

- Live: `npx wrangler tail <worker-name>` (the `WORKER_NAME` value, default `remote-support-booking`) streams requests, exceptions and `console` output as they happen. `--status error` shows only failures.
- History: in the Cloudflare dashboard, open **Workers & Pages**, choose the Worker and open **Observability** (Workers Observability) to search and filter past logs and invocations.

The staff **Activity** page shows the application's own audit log.

### Rollback

Every `npm run deploy` creates a Worker version. To go back to a previous one:

```bash
npx wrangler deployments list           # recent deployments with their version ids
npx wrangler rollback [version-id]      # without an id, rolls back to the previous deployment
```

A rollback changes the code only: `wrangler rollback` does not undo secret or binding changes, and it does not undo D1 migrations. **D1 migrations are forward-only**, so the older code must run against the newer schema. This is why every migration has to stay backward compatible with the previous release (section 8): after a rollback the previous release runs against the current schema. If a bad migration or bad data is the problem, restore the database instead (next section). Run the smoke test after a rollback too.

### D1 backups (Time Travel)

D1 keeps a continuous history of the database (Time Travel), so it can be restored to any minute in the last 30 days without having set anything up:

```bash
npx wrangler d1 time-travel info <database-name>                          # current bookmark and the restorable window
npx wrangler d1 time-travel restore <database-name> --timestamp=<unix-or-ISO-time>
npx wrangler d1 time-travel restore <database-name> --bookmark=<bookmark>
```

`info` also accepts `--timestamp` to show the bookmark for a point in time. A restore **replaces the whole database in place**: everything written after that moment (reservations, emails, sessions) is lost, and the command prints a bookmark for the state just before the restore, so a restore can itself be undone. Note the current bookmark (`info`) before restoring, and consider pausing online booking (Settings) while you do it. Restoring is a database operation only: it does not change the deployed Worker, and the Worker's migrations are tracked in the database itself, so restoring to before a migration makes the next deploy apply it again.

For an extra copy outside Cloudflare, `npx wrangler d1 export <database-name> --remote --output backup.sql` writes the schema and data to a file (store it as carefully as the customer data it contains).

### Smoke test

After a deployment, check the live site from outside:

```bash
npm run smoke -- https://booking.example.com
npm run smoke -- https://booking.example.com --wait 60   # first poll /api/health for up to 60 seconds
```

It prints a pass/fail table and exits non-zero if anything fails: the health endpoint; the redirect from `http://` to `https://`; the security headers on the page and the API (`Content-Security-Policy` with `frame-ancestors 'none'`, `Referrer-Policy`, `X-Content-Type-Options`, and `Strict-Transport-Security` with a max-age of at least a day); that the development routes (`/api/dev/*`) are not reachable (404 `not_found`); that a state-changing API call without the `X-Requested-With: fetch` header is refused (403 `csrf`, the CSRF guard); and that `/api/auth/me` answers, reporting whether online booking is currently enabled (informational). Each request times out after 15 seconds and shows as a failed check. The HTTPS redirect comes from the Cloudflare zone's **Always Use HTTPS** setting (**SSL/TLS → Edge Certificates**), so turn it on for the zone; the HSTS header comes from the app's own responses (the Worker for the API and `public/_headers` for the pages). The deploy workflow runs the script automatically after every deployment (with `--wait 60`). It sends no credentials and changes no data, so it is safe to run against production. Against a local server (`http://localhost:5173`) the HTTPS redirect is skipped and the `Strict-Transport-Security` checks fail, which is expected.

### What the cron does on the first deployment

The Cron Trigger starts running every minute as soon as the Worker is deployed (section 9). On a database that is new, nothing is due and it does nothing visible. On a database that already holds old rows, for example when upgrading, the first runs close every pending request and proposal that is already past its deadline and complete every confirmed appointment that has ended. They do this **silently for stale items**: a request whose requested time has passed, or whose deadline was more than 24 hours ago, is expired and its technician hold released without emailing anyone (the activity log records that nobody was emailed), so customers and staff are not sent a flood of old news. Backlogs are processed in bounded batches (50 rows per kind per run), so a large one drains over the next few minutes. Nothing needs to be done; watch the staff Activity page or `wrangler tail` if you want to see it happen.
