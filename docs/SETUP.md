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
