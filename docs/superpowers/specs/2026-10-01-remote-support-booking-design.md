# Remote-Support Booking — Design Spec

Date: 2026-10-01 · Status: approved for implementation

An open-source, self-hostable reservation app for a small technical-service team that runs remote-support sessions (phone call + a remote-access tool such as TeamViewer). Customers request a time through emailed magic links; staff approve and assign a technician; everything else happens by email.

The repository is **generic**: no organisation name, domain, email address or customer data is committed. Every deployment-specific value comes from environment variables (kept in Doppler for the reference deployment) or from admin-editable settings stored in the database.

---

## 1. Scope

**In scope:** eligible-customer magic-link access, slot booking with technician-aware capacity, staff approval/assignment, rescheduling proposals, cancellation, reminders, staff scheduling, customer administration with CSV import, staff management, audit log, email outbox with retries, `.ics` export, English UI with an i18n catalog.

**Out of scope:** payments, subscriptions, AI, CRM features, TeamViewer API, meeting links, Outlook/Graph integration, calendar subscriptions, public self-registration, storing remote-access credentials.

---

## 2. Stack and architecture

| Layer | Choice | Why |
|---|---|---|
| Runtime | One Cloudflare Worker | API, static assets, cron and inbound email in one deploy |
| Frontend | React 19 + Vite + React Router + TanStack Query + Tailwind CSS v4 | Simple SPA, mobile-first, no SSR needed |
| API | Hono + Zod | Small, typed, Workers-native |
| Database | Cloudflare D1 (SQLite), SQL migrations via `wrangler d1 migrations` | Atomic `batch()` + `UNIQUE` constraints give race-safety |
| Email | Cloudflare Email Service `send_email` binding (prod); dev mailbox adapter (local) | No API key to leak; sender allow-list enforced by platform |
| Timezones | `date-fns` + `@date-fns/tz` | Small; correct wall-clock ↔ UTC conversion |
| Tests | Vitest + `@cloudflare/vitest-pool-workers` (real workerd + D1); Playwright smoke | Race tests run against real D1 semantics |
| Bot protection | Cloudflare Turnstile on email-entry forms (skipped when no secret is configured) | |

```
APP_DOMAIN ──► Worker
  ├─ static assets   React SPA  (/, /book, /my, /r/:token, /auth/*, /staff/*)
  ├─ /api/*          Hono routes (JSON; all state changes are POST/PUT/DELETE)
  ├─ scheduled()     every minute: email outbox, approval reminders/escalation/expiry,
  │                  proposal expiry, customer reminders, completion
  └─ email()         inbound mail to the sender subdomain → relayed to every notify staff member (Reply-To = the customer)
```

### Source layout

```
src/domain/     pure TS, no Cloudflare imports: states, matching, slots, business hours, policies
src/worker/     Hono app, auth, repositories (D1), mail adapters + templates, jobs, cron
src/web/        React app (customer + staff), i18n catalog
src/shared/     Zod schemas and types shared by web + worker
migrations/     D1 SQL
test/           vitest-pool-workers suites; e2e/ Playwright
scripts/        render-wrangler.mjs, seed-dev.mjs
docs/           this spec, plan, SETUP.md, sample-customers.csv, verification report
```

The domain layer is pure so it can be unit-tested exhaustively and ported if the app ever leaves Cloudflare. D1 and the mailer sit behind small interfaces.

### Configuration (public-repo safe)

`wrangler.template.jsonc` is committed with `${VAR}` placeholders; `scripts/render-wrangler.mjs` renders `wrangler.jsonc` (gitignored) from `process.env`. It works identically under `doppler run --` or with a local `.env`.

| Variable | Kind | Example / default |
|---|---|---|
| `APP_DOMAIN` | config | `booking.example.com` (custom domain route; base URL = `https://APP_DOMAIN`) |
| `ORG_NAME` | config | `Example Support` (initial value; editable in settings afterwards) |
| `MAIL_FROM` | config | `no-reply@booking.example.com` (also the allowed sender) |
| `MAIL_FROM_NAME` | config | `Example Support` |
| `MAIL_MODE` | config | `cloudflare` (prod) · `dev` (local mailbox, viewable at `/dev/mail`) |
| `APP_TIMEZONE` | config | `UTC` default; reference deployment `Asia/Tokyo` |
| `APP_LOCALE` | config | `en` |
| `CLOUDFLARE_ACCOUNT_ID` | config | |
| `D1_DATABASE_ID` | config | |
| `TURNSTILE_SITE_KEY` | config | optional |
| `CLOUDFLARE_API_TOKEN` | secret (deploy) | scoped: Workers Scripts, D1, Workers Routes on the zone |
| `TURNSTILE_SECRET_KEY` | secret (runtime) | optional |
| `BOOTSTRAP_ADMIN_EMAILS` | secret (runtime) | comma-separated; see §5.4 |

There are no signing keys: magic-link tokens, reservation-access tokens and session IDs are 256-bit random values and only their SHA-256 hashes are stored.

---

## 3. Data model (D1)

All instants are stored as `INTEGER` Unix epoch **milliseconds (UTC)**. Wall-clock schedule definitions are stored as minutes-from-midnight in `APP_TIMEZONE`. Dates as `TEXT 'YYYY-MM-DD'` in `APP_TIMEZONE`.

- `settings(key PRIMARY KEY, value TEXT JSON)` — see §9.
- `holidays(date PRIMARY KEY, name)`
- `staff(id, email UNIQUE NOCASE, name, role 'admin'|'technician', bookable INTEGER, notify INTEGER, active INTEGER, created_at, updated_at)` — `bookable` = appears as a technician; an admin can be bookable.
- `customers(id, customer_number UNIQUE, name, phone, active, notes, created_at, updated_at)`
- `customer_contacts(id, customer_id, email NOCASE, name, phone, active, UNIQUE(customer_id, email))` — the same email may belong to several customers; accounts are never merged.
- `auth_tokens(id, token_hash UNIQUE, kind 'customer'|'staff', email, redirect_path, created_at, expires_at, used_at)`
- `sessions(id_hash PRIMARY KEY, kind 'customer'|'staff', email, staff_id, created_at, expires_at, last_seen_at, revoked_at)`
- `access_tokens(id, token_hash UNIQUE, reservation_id, created_at, expires_at)` — per-reservation links in customer emails (view / cancel / respond to proposal). Minted at send time, so raw tokens never sit in the database.
- `availability_windows(id, kind 'weekly'|'date', weekday, date, start_min, end_min)` + `availability_window_staff(window_id, staff_id)`
- `date_overrides(date PRIMARY KEY, note)` — if present, that date uses only its `kind='date'` windows (zero windows = closed). Holidays close the weekly pattern unless a date override exists.
- `staff_unavailability(id, staff_id, start_at, end_at, reason)`
- `reservations(id, ref UNIQUE, customer_id, contact_email, contact_name, phone, issue, start_at, end_at, status, assigned_staff_id, provisional_staff_id, version, replaces_id, idempotency_key UNIQUE, approval_reminder_at, escalation_at, expires_at, created_at, updated_at, confirmed_at, confirmed_by, closed_at, closed_by_kind, closed_by, close_reason)`
- `proposals(id, reservation_id, status, message, created_by, created_at, expires_at, resolved_at)` + `proposal_options(id, proposal_id, start_at, end_at, staff_id)`
- `tech_blocks(staff_id, block_start, owner_kind 'reservation'|'option', owner_id, PRIMARY KEY(staff_id, block_start))` — `block_start` in epoch **minutes**, 5-minute grid.
- `schedule_state(id=1, version)` — global optimistic-concurrency counter for capacity changes.
- `email_jobs(id, dedupe_key UNIQUE, template, to_email, reservation_id, payload JSON, status 'queued'|'sending'|'sent'|'failed'|'skipped'|'cancelled', attempts, send_after, locked_until, last_error, created_at, sent_at)`
- `dev_mailbox(id, to_email, subject, html, text, created_at)` — dev mode only.
- `audit_log(id, at, actor_kind 'customer'|'staff'|'system', actor, action, reservation_id, customer_id, details JSON)`
- `rate_limits(key PRIMARY KEY, window_start, count)`

Reservation references are 8 characters from an unambiguous alphabet (`23456789ABCDEFGHJKMNPQRSTUVWXYZ`), shown as `R-XXXX-XXXX`.

---

## 4. Scheduling and capacity

### 4.1 Slots

- Settings: `duration_min` (default 30), `buffer_before_min` (0), `buffer_after_min` (10), `slot_step_min` (default = duration), all multiples of 5.
- A **window** (weekly or date-specific) lists named technicians. Slots start at `window.start + k·step` while `start + duration ≤ window.end`.
- Technicians *eligible* for a slot: listed on the window, `active` and `bookable`, and with no `staff_unavailability` overlapping the slot's **occupied range** `[start − buffer_before, end + buffer_after)`.
- Customers see slots from `now + min_notice` (default **3 business hours**) to `today + booking_horizon_days` (default **30**).

### 4.2 Technician-identity capacity

- A reservation or proposal option *occupies* its technician's 5-minute blocks over the occupied range. `tech_blocks` has `PRIMARY KEY(staff_id, block_start)`, so the database itself rejects any overlap for the same technician, buffers included.
- **Confirmed** reservations and **proposal options** are fixed to their technician.
- **Pending** reservations have a `provisional_staff_id`, which the allocator may move to another eligible technician. Customers and the approval UI never treat it as an assignment.
- **Allocation** = bipartite matching (augmenting paths) between flexible holds and eligible technicians, given the fixed holds. Scope is limited to holds whose occupied ranges overlap the affected interval (connected component), which is tiny for a small team.
- **Spots remaining** for slot S = the maximum k such that k new holds at S plus all existing flexible holds can still be matched. Displayed as "2 spots left" / "Last spot" / hidden when 0.

### 4.3 Atomic writes

Every capacity-changing operation (submit, approve, reassign, cancel, decline, expire, propose, accept, roster edit):

1. Reads `schedule_state.version` and the relevant rows.
2. Computes the new state in the domain layer (pure).
3. Commits one `db.batch()` that begins with an **assertion** — an insert into a guard table with `CHECK` that fails unless `schedule_state.version` and each touched reservation's `status/version` still match — then deletes/inserts `tech_blocks`, updates rows, enqueues `email_jobs`, writes `audit_log`, and bumps `schedule_state.version`.
4. If the assertion or a `tech_blocks` uniqueness check fails, the whole batch rolls back; the operation re-reads and retries (max 5). If the precondition is genuinely gone (e.g. request no longer pending), the API returns a typed **conflict** with the current state and who handled it.

This makes "only one approval succeeds", "last spot goes to one customer", and approval-vs-cancellation races deterministic.

### 4.4 Roster edits

Editing windows, overrides, unavailability or deactivating a technician runs a **preview**: the allocator re-matches pending holds (silently moved provisionals are listed), and lists **conflicts** — confirmed reservations or proposal options that would lose their technician. Saving is blocked while conflicts remain; each conflict offers, in order: *Reassign (same time)* to an eligible technician, *Propose new time*, *Cancel with reason*. Pending requests that can no longer be matched at all are conflicts too (resolve by propose/decline).

---

## 5. Access and security

### 5.1 Customer magic link

1. `/` — the customer enters an email (+ Turnstile). The server always answers: "If this email is registered for remote support, you'll receive a booking link shortly."
2. If the email is an active contact of ≥1 active customer: create an `auth_tokens` row (15 min expiry) and enqueue the email with a large **Book a remote support session** button → `/auth/verify#t=<token>` (fragment keeps the token out of server/proxy logs and `Referer`).
3. `/auth/verify` shows **Continue** (one tap). The click POSTs the token; the server marks it used (single-use) and sets the session cookie. Email-security scanners that prefetch GET URLs cannot consume the token.
4. Expired or used token: a clear page with **Send me a new link** — the server looks up the email from the token row (even if expired) and re-runs step 2 (neutral response).
5. `redirect_path` stored with the token preserves the journey (e.g. a chosen date).

Customer session: cookie `__Host-cust`, HttpOnly, Secure, SameSite=Lax, 24 h. Eligibility is re-checked when listing accounts and again inside the submit transaction.

**Multiple accounts:** if the verified email belongs to several active customers, `/book` starts with an account picker. **Multiple contacts:** any active contact of an account can see and cancel that account's reservations under `/my`.

### 5.2 Staff magic link

Same flow at `/staff/login`, restricted to active `staff` rows; cookie `__Host-staff`, 14-day sliding expiry. Staff links in notification emails are plain URLs (`/staff/r/:id?action=approve`) that **carry no credential**. Without a session, the SPA sends the user to login with `redirect_path` set, then returns them to the action.

Customer and staff sessions use different cookies, tables are checked by `kind`, and every staff route requires an active staff session. A customer token or cookie can never satisfy a staff check.

### 5.3 Reservation access links

Customer emails link to `/r#t=<token>` (view, cancel, respond to a proposal, download `.ics`). Tokens are minted per email at send time, valid until 14 days after the reservation ends, and scoped to that one reservation. They are not single-use, because cancel and accept are explicit POSTs with confirmation. Cancellation works even if the customer has since been made ineligible.

### 5.4 Initial administrator

`BOOTSTRAP_ADMIN_EMAILS` (secret). When an email in that list requests a staff link **and no active admin exists**, a staff row (admin, bookable) is created. Once any admin exists, the variable is inert, and admins manage staff in the UI. An admin cannot demote or deactivate the last active admin.

### 5.5 Roles

| Action | Admin | Technician |
|---|---|---|
| View team calendar, requests, customers | ✓ | ✓ |
| Approve/assign (any eligible technician, incl. self), decline, propose, reassign, cancel | ✓ | ✓ |
| Manage availability windows/overrides; own unavailability | ✓ | own unavailability only |
| Customers add/edit/activate/import | ✓ | view |
| Staff management, settings, holidays, email retries | ✓ | view email failures |

Enforced server-side with a `requireStaff(role?)` middleware on every route.

### 5.6 Other controls

- State changes only via non-GET; every non-GET requires `Origin` = `https://APP_DOMAIN` and header `X-Requested-With: fetch` (CSRF). JSON-only bodies.
- Rate limits (D1 counters): login-link requests 3 / 15 min per email and 20 / 15 min per IP; token redemption 30 / 15 min per IP; submit 10 / hour per session.
- Tokens are never logged; URLs carry tokens only in fragments; responses include `Referrer-Policy: no-referrer`, a strict CSP, `X-Content-Type-Options`, and `frame-ancestors 'none'`.
- Explicit logout revokes the session row.
- Ownership: every customer endpoint checks that the reservation's customer has the session email as a contact (or, for `/r`, that the access token matches).

---

## 6. Reservation lifecycle

### 6.1 States

```
                approve(tech)                 end_at passed (cron)
 pending ─────────────────────► confirmed ─────────────────────► completed
   │ ├─ decline(reason) ─► declined   │  ├─ reassign(tech, same time) ↺
   │ ├─ expire (cron) ───► expired    │  └─ cancel ─► cancelled
   │ └─ cancel ──────────► cancelled  │
   └── (proposal may be open on pending or confirmed) ──┘
```

Terminal: `declined`, `expired`, `cancelled`, `completed`. Each transition increments `version`, writes `audit_log`, and enqueues emails.

### 6.2 Submission

Inputs: account, slot start, contact name, callback phone, issue (≤ 1000 chars), client-generated `idempotency_key`. In one batch: assert eligibility, the max-active-per-account limit (default 1, counting pending + confirmed + replacement requests), min-notice and that the slot still exists; allocate a provisional technician; insert the reservation (`pending`); enqueue *request-received* (customer) and *new-request* (all `notify` staff). A retried submit with the same key returns the existing reservation.

Deadlines (business hours from settings; holidays excluded):
- `approval_reminder_at = created + 2 BH` → reminder to all notify staff
- `escalation_at = created + 4 BH` → escalation to admins
- `expires_at = min(created + 8 BH, start − 60 min)`; reminder/escalation clamp to ≤ `expires_at − 30 min`.
- Expiry → `expired`, capacity released, customer gets an expiry email with a rebook link; staff notified.

### 6.3 Approval

`/staff/r/:id` shows the request; **Approve** lists technicians: eligible and assignable (a valid matching exists with this request fixed to them) first, the current user preselected when assignable ("Assign to me"); others greyed with the reason. Confirm → batch: assert pending + version, re-check customer eligibility, fix tech blocks to the chosen technician (re-matching other pending holds if needed), set `confirmed`, enqueue *confirmation* (customer), *assigned* (team), and appointment reminders. A stale or duplicate approval returns a conflict page: "Already confirmed by Alice at 10:42 — assigned to Bob."

### 6.4 Reassign, decline, cancel

- **Reassign** (confirmed only, same time): pick another assignable technician → team notification; the customer gets a short "your appointment details are unchanged" email only if `notify_customer_on_reassign` is set (default off — the customer does not choose a technician).
- **Decline** (pending only): reason required (shown to the customer) → *declined* email.
- **Cancel** — customer: pending any time; confirmed until `cancel_cutoff_min` (default 60) before start, after which the page shows the support phone number. Staff: any non-terminal, reason required. Releases blocks, cancels open proposals and unsent reminder jobs, notifies the customer and the team. Repeating a cancel returns the current state without side effects.

### 6.5 Rescheduling proposals

- Staff choose 1–3 alternative slots, each with an assignable technician; each option gets a fixed **hold** (`tech_blocks owner_kind='option'`). The original reservation keeps its capacity.
- Only one open proposal per reservation; a new one supersedes the old (old holds released).
- Expiry: `min(created + 24 BH, original.start − 120 min, earliest option.start − 60 min)`. Expiry releases option holds, keeps the original unchanged, and emails customer + staff.
- **Customer accepts an option** → atomic move: assert proposal open + reservation version; release original blocks; convert option blocks to the reservation; status becomes/stays `confirmed` with the option's technician (a staff-proposed time is pre-approved); other options released; emails *rescheduled-confirmed* (with an updated `.ics`, `SEQUENCE` = version) + team notification.
- **Customer declines all / picks another time** → the customer is taken to the normal slot picker; submitting creates a new `pending` reservation with `replaces_id` = original. The original stays held (confirmed or pending) until the replacement is approved (then the original is cancelled with reason *rescheduled* in the same batch) or declined/expired (the original stays as-is). Open proposal status → `rejected`.
- **Customer declines and keeps the original** → proposal `rejected`, holds released, staff notified.
- Stale links (proposal superseded/expired/resolved): the page shows the current reservation and options instead of acting.

---

## 7. Email

### 7.1 Outbox

All mail goes through `email_jobs`, inserted in the same batch as the state change (so a saved reservation never depends on mail success). After commit, the request handler calls `ctx.waitUntil(processOutbox())`; cron also runs it every minute.

- Claim: `UPDATE … SET status='sending', locked_until=now+60s WHERE id=? AND (status='queued' OR (status='sending' AND locked_until<now)) AND send_after<=now`.
- **Precondition at send time**: each template declares the reservation statuses it is valid for (e.g. reminders require `confirmed` and an unchanged `start_at`); otherwise the job becomes `skipped`. This covers delayed reminders after cancel/reschedule.
- Failure → `attempts+1`, exponential backoff (1, 5, 15, 60, 240 min); after 6 attempts → `failed`. Failed jobs are listed in the staff UI with **Retry** (resets to queued) — admins only.
- `dedupe_key` (e.g. `confirm:<reservationId>:v<version>`) makes enqueueing idempotent.
- Delivery is at-least-once: a crash between send and mark-sent can duplicate a message; this is accepted and documented.

### 7.2 Templates

Every email has HTML (mobile-friendly, single column, 44px-tall buttons) + plain text, built from the i18n catalog.

| Template | To | Key content |
|---|---|---|
| `customer_login` | customer | big "Book a remote support session" button, 15-min expiry note |
| `staff_login` | staff | sign-in button |
| `request_received` | customer | **Pending — not yet confirmed**, account, date/time/timezone, ref, view + cancel links |
| `new_request` | notify staff | account, contact, phone, issue, time/timezone, ref, status; buttons: Approve & assign to me · Approve/assign… · Propose another time · Details |
| `confirmed` | customer | **Confirmed**, account, time/timezone, ref, "technician will call you; have your computer and {remote tool} ready", view + cancel + add-to-calendar |
| `assigned` | notify staff | who approved, assigned technician, details |
| `approval_reminder` / `approval_escalation` | notify staff / admins | pending requests nearing expiry |
| `declined` / `expired` | customer | reason / "we could not confirm in time", rebook link |
| `proposal` | customer | reason, 1–3 alternative times, accept buttons, "choose another time", keep-original option, expiry |
| `proposal_outcome` | customer + staff | accepted / rejected / expired |
| `rescheduled` | customer | new confirmed time + updated .ics |
| `cancelled` | customer + staff | who cancelled, when, rebook link |
| `appointment_reminder` | customer | 24 h and 1 h before (configurable offsets; confirmed only) |
| `reassigned` | staff (+ customer optional) | |

### 7.3 Sending domain

The deployment onboards **a subdomain** (e.g. `booking.example.com`) to Cloudflare Email Service for sending, and optionally Email Routing on that same subdomain for replies. **Never run zone-level Email Routing on the apex** of a domain whose apex mail is hosted elsewhere — it proposes replacing the apex MX/SPF. Setup steps and DNS verification are documented in `docs/SETUP.md`. Production uses the `send_email` binding with `allowed_sender_addresses = [MAIL_FROM]`.

---

## 8. User experience

Mobile-first; every action is reachable with one thumb; touch targets ≥ 44px; the timezone label is visible wherever times are shown ("All times in Asia/Tokyo (GMT+9)").

**Customer**
- `/` — one field (email) + button; the neutral confirmation replaces the form; "Didn't get it? Check spam or try again in a minute".
- `/auth/verify` — one big **Continue** button; expired state with **Send me a new link**.
- `/book` — (account picker if needed) → horizontal date strip of the next 30 days, days without availability dimmed → slot list as large buttons with "2 spots left"/"Last spot" → details form (contact name and phone prefilled from the contact record and the last booking) → review card → submit. A sticky bottom bar on mobile shows the current selection. If the slot was taken meanwhile: inline message + refreshed slots, keeping the entered details.
- Success — a big amber **Request received — not yet confirmed** state with the exact suggested wording, ref, and "What happens next" (1. we review, 2. you get a confirmation email, 3. a technician calls you).
- `/my` — reservation cards with status chips (Pending/Confirmed/Proposal waiting/Cancelled…), actions inline.
- `/r` — single reservation page: status banner, details, primary actions (respond to proposal, add to calendar, cancel), cancellation confirm dialog.

**Staff**
- `/staff` — Today: pending queue sorted by deadline with countdowns; today's confirmed list; red banner when emails have failed.
- `/staff/calendar` — week grid on desktop (columns = days, coloured blocks: amber pending, green confirmed, violet proposal open, dashed = unassigned/provisional), agenda list on mobile; filters for technician, status and date.
- `/staff/r/:id` — details, action panel (Approve · Propose · Decline · Reassign · Cancel), audit timeline. Query `?action=` opens the right panel directly.
- `/staff/schedule` — weekly pattern editor (per weekday, time ranges with technician chips), date overrides, unavailability; conflict preview modal before save.
- `/staff/customers` — search, add/edit, contacts, activate/deactivate; CSV import: upload → preview table with per-row errors/warnings (create/update/unchanged) → apply.
- `/staff/team`, `/staff/settings`, `/staff/holidays`, `/staff/emails`, `/staff/audit` (admin-focused).

CSV columns: `customer_number,name,phone,contact_email,contact_name,active`. One row per contact; rows sharing a `customer_number` merge contacts into one account; customer number is the key for updates; import never deletes.

**Calendar export:** for confirmed reservations only, `GET /api/r/ics` (customer, by access token) and `/api/staff/reservations/:id/ics`. `UID = <ref>@APP_DOMAIN`, `SEQUENCE = version`, `METHOD:PUBLISH`. UI copy states that the downloaded event is a snapshot and that emails announce later changes.

---

## 9. Settings (admin-editable, seeded with defaults)

`org_name`, `support_phone`, `remote_tool_name` ("TeamViewer"), `customer_instructions`, `duration_min` 30, `buffer_before_min` 0, `buffer_after_min` 10, `slot_step_min` 30, `min_notice_bh` 3, `booking_horizon_days` 30, `cancel_cutoff_min` 60, `max_active_per_account` 1, `business_hours` Mon–Fri 09:00–18:00, `approval_reminder_bh` 2, `approval_escalation_bh` 4, `approval_expiry_bh` 8, `expiry_before_start_min` 60, `proposal_expiry_bh` 24, `proposal_expiry_before_start_min` 120, `customer_reminder_offsets_min` [1440, 60], `notify_customer_on_reassign` false.

---

## 10. Testing

Domain unit tests: business hours across nights/weekends/holidays, slot generation incl. DST zones, matching (provisional moves, buffers, overlap across adjacent slots), state transitions.

Integration (workerd + D1) — the required risk list:
1. Unauthorized access: customer cookie on staff routes; other customer's reservation; staff link without session.
2. Expired / reused / wrong-kind tokens.
3. Two concurrent submits for the last spot → exactly one succeeds.
4. Overlapping technician allocations (adjacent slots + buffers).
5. Duplicate approval (parallel + retry) → one confirmation, one set of emails.
6. Approval vs cancellation race → consistent final state.
7. Stale proposal links; superseded proposals; accept after option taken.
8. Roster change conflicts block save and require resolution.
9. Expiry releases capacity; reminders skipped after cancel.
10. Email failure → retry → failed → manual retry; reservation unaffected.
11. Idempotent submit.

E2E (Playwright, dev mail mode): customer login → book → staff login → approve → customer sees Confirmed.

---

## 11. Delivery

1. Scaffold, config rendering, migrations, CI (gitleaks, typecheck, tests), MIT licence, generic `README.md` (what the app does, who it is for, features, screenshots later, quick start, configuration, deployment pointer to `docs/SETUP.md`).
2. Smallest complete flow: eligible customer → magic link → pending → staff approval/assignment → confirmation.
3. Scheduling UI + roster conflicts, customer admin + CSV, cancellation, rescheduling, reminders/expiry, `.ics`, audit, email admin.
4. Deploy: Doppler `booking-app` (dev/prd), D1 `booking-app`, custom domain, Email Service on the app subdomain, Turnstile; `docs/SETUP.md`, `.env.example`, `docs/sample-customers.csv`, verification report.

Real email delivery is verified only after the sending subdomain is onboarded; until then the dev mailbox is used and labelled as such.
