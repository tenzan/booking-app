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
| Account | Email Routing Addresses | Edit | Verify the address customer replies are forwarded to |
| Account | Account Settings | Read | Wrangler account lookups |
| Account | Workers Tail | Read | Live logs (optional) |
| Zone | Zone | Read | Look up the zone |
| Zone | Zone Settings | Edit | Email Routing setup for the app hostname |
| Zone | DNS | Edit | App hostname and email DNS records |
| Zone | Workers Routes | Edit | Attach the custom domain to the Worker |
| Zone | Email Routing Rules | Edit | Route inbound replies on the app hostname |

- **Account Resources:** include only your account.
- **Zone Resources:** *Specific zone* → the zone that will host the app hostname.
- **Client IP filtering:** leave off if you deploy from CI (GitHub Actions IPs change).

If you prefer not to grant the two email permissions, you can instead onboard the app hostname for Email Sending and Email Routing by hand in the dashboard (Email section) before the first deploy.

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
| `MAIL_REPLY_FORWARD_TO` | config | `support-team@example.com` | Where customer replies are forwarded (optional) |
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

**First administrator:** open `https://APP_DOMAIN/staff/login` and request a link with an address listed in `BOOTSTRAP_ADMIN_EMAILS`.

## 5. Continuous deployment (GitHub Actions)

`.github/workflows/deploy.yml` deploys every push to `main` after typecheck and tests. It reads all configuration from Doppler at run time and needs one repository secret:

```bash
doppler configs tokens create github-actions --project <your-project> --config prd --plain \
  | gh secret set DOPPLER_TOKEN --repo <owner>/<repo>
```

Without that secret the deploy job is skipped, so forks of this repository stay green.

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
