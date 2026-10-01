# Plan 1 — Foundation and Core Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A working app where an eligible customer gets a magic link, requests a slot (pending, capacity held), staff sign in, approve with a technician, and the customer receives a confirmation — all emails through a durable outbox.

**Architecture:** One Cloudflare Worker (Hono API + React SPA assets + cron). Pure-TS domain layer (`src/domain`) for time, slots, matching and deadlines; D1 for storage with atomic `batch()` writes protected by guard assertions and `UNIQUE` technician blocks.

**Tech Stack:** TypeScript ~6.0, Vite 8, `@cloudflare/vite-plugin` 1.62, wrangler 4.145, Hono 4, Zod 4, React 19, React Router (latest major, library mode, `react-router`), TanStack Query 5, Tailwind CSS 4, date-fns 4 + `@date-fns/tz`, Vitest **4.1.x** + `@cloudflare/vitest-pool-workers` 0.22, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-01-remote-support-booking-design.md`

## Global Constraints

- **Public, generic repo.** No real domain, email address, organisation name, account ID or customer data in any committed file. Use `example.com` / `example.test` and obviously synthetic names. Deployment values come from env vars (Doppler in the reference deployment).
- `compatibility_date` = `"2026-08-15"` (newest the bundled workerd supports). `"type": "module"` in package.json.
- Vitest must stay on `~4.1.11` (pool-workers peer range `^4.1.0`).
- All instants stored as INTEGER epoch milliseconds UTC; tech blocks in epoch minutes on a 5-minute grid; schedule wall-clock in `APP_TIMEZONE`.
- No GET request may change state. Every non-GET API request must have `Origin` equal to the app origin and header `X-Requested-With: fetch`.
- Raw tokens (magic link, access, session) are never stored or logged; store `sha256` hex only. Tokens travel in URL **fragments** (`#t=`) and are POSTed by the SPA.
- UI and emails English via the catalog in `src/shared/i18n/en.ts`; never hardcode user-facing strings elsewhere.
- Times shown to users always include the timezone label.
- Commits end with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_013dotuJr9szQKpiFyXppbcd
  ```

## File Structure

```
package.json, tsconfig.json, vite.config.ts, vitest.config.ts, playwright.config.ts
scripts/render-wrangler.mjs        builds wrangler.jsonc from env (dev defaults; --strict for deploy)
scripts/seed-dev.mjs               synthetic local data
migrations/0001_init.sql           full schema
src/shared/types.ts                status unions, DTOs shared web↔worker
src/shared/i18n/en.ts, i18n.ts     catalog + t()
src/domain/time.ts                 tz conversions
src/domain/business-hours.ts       addBusinessMinutes
src/domain/settings.ts             Settings type + DEFAULT_SETTINGS
src/domain/slots.ts                slot generation, occupied ranges, blocks
src/domain/matching.ts             solve / spotsFor / assignableFor
src/domain/deadlines.ts            approval deadlines
src/domain/ref.ts                  reservation reference generator
src/worker/index.ts                fetch/scheduled/email entry
src/worker/app.ts                  Hono app + route mounting
src/worker/env.ts                  Env + Hono Variables types
src/worker/lib/{crypto,clock,http,db,rate-limit,turnstile}.ts
src/worker/middleware/{security,session}.ts
src/worker/repos/{settings,staff,customers,schedule}.ts
src/worker/auth/routes.ts
src/worker/mail/{layout,templates,adapters,outbox}.ts
src/worker/scheduling/{context,availability}.ts
src/worker/reservations/{submit,approve,decline,queries,customer-routes,staff-routes,access-routes}.ts
src/worker/dev/routes.ts           dev mailbox (MAIL_MODE=dev only)
src/web/main.tsx, App.tsx, api.ts, i18n.ts, format.ts, index.css
src/web/components/*.tsx
src/web/pages/customer/*.tsx, src/web/pages/staff/*.tsx, src/web/pages/DevMail.tsx
test/setup.ts, test/helpers.ts, test/**/*.test.ts
e2e/core-flow.spec.ts
README.md, LICENSE, .gitignore, .env.example, .gitleaks.toml, .github/workflows/ci.yml, docs/sample-customers.csv
```

---

### Task 1: Scaffold, config rendering, schema, CI, README

**Files:**
- Create: `package.json`, `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`, `scripts/render-wrangler.mjs`, `migrations/0001_init.sql`, `src/worker/index.ts`, `src/worker/app.ts`, `src/worker/env.ts`, `src/web/main.tsx`, `src/web/App.tsx`, `src/web/index.css`, `index.html`, `test/setup.ts`, `test/helpers.ts`, `test/health.test.ts`, `README.md`, `LICENSE`, `.gitignore`, `.env.example`, `.gitleaks.toml`, `.github/workflows/ci.yml`, `docs/sample-customers.csv`

**Interfaces:**
- Produces: `Env` (src/worker/env.ts), `app` (Hono instance, `src/worker/app.ts`), test helper `api(method, path, opts)` returning `{ status, json, headers, cookies }`, `GET /api/health → { ok: true }`.

- [ ] **Step 1: package.json**

```json
{
  "name": "remote-support-booking",
  "private": true,
  "type": "module",
  "license": "MIT",
  "scripts": {
    "config": "node scripts/render-wrangler.mjs",
    "dev": "npm run config && wrangler d1 migrations apply DB --local && vite",
    "build": "npm run config && vite build",
    "typecheck": "tsc --noEmit",
    "test": "npm run config && vitest run",
    "test:watch": "npm run config && vitest",
    "e2e": "playwright test",
    "seed": "npm run config && node scripts/seed-dev.mjs",
    "deploy": "node scripts/render-wrangler.mjs --strict && vite build && wrangler d1 migrations apply DB --remote && wrangler deploy"
  }
}
```

Install (pin exactly as listed):

```bash
npm i hono@^4.13 zod@^4.6 react@^19.3 react-dom@^19.3 react-router@latest @tanstack/react-query@^5.104 date-fns@^4.4 @date-fns/tz@^1.5
npm i -D typescript@~6.0.3 vite@^8.3 @cloudflare/vite-plugin@^1.62 wrangler@^4.145 @vitejs/plugin-react@^6 tailwindcss@^4.3 @tailwindcss/vite@^4.3 vitest@~4.1.11 @cloudflare/vitest-pool-workers@0.22.0 @cloudflare/workers-types @types/react @types/react-dom @playwright/test@^1.63
```

Use React Router's library-mode API (`BrowserRouter`, `Routes`, `Route`, `useNavigate`, `useParams`, `useSearchParams`, `Link`).

- [ ] **Step 2: `scripts/render-wrangler.mjs`**

Builds `wrangler.jsonc` (gitignored). Without `--strict` it fills safe local defaults; with `--strict` every required var must be present.

```js
import { writeFileSync, existsSync, readFileSync } from "node:fs";

// Load .env if present (simple KEY=VALUE parser) without overriding real env.
if (existsSync(".env")) {
  for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
const strict = process.argv.includes("--strict");
const REQUIRED = ["APP_DOMAIN", "MAIL_FROM", "MAIL_FROM_NAME", "ORG_NAME", "APP_TIMEZONE", "CLOUDFLARE_ACCOUNT_ID", "D1_DATABASE_ID"];
const env = process.env;
if (strict) {
  const missing = REQUIRED.filter((k) => !env[k]);
  if (missing.length) { console.error(`Missing env vars: ${missing.join(", ")}`); process.exit(1); }
}
const domain = env.APP_DOMAIN || "localhost";
const config = {
  $schema: "node_modules/wrangler/config-schema.json",
  name: env.WORKER_NAME || "remote-support-booking",
  main: "src/worker/index.ts",
  compatibility_date: "2026-08-15",
  compatibility_flags: ["nodejs_compat"],
  ...(env.CLOUDFLARE_ACCOUNT_ID ? { account_id: env.CLOUDFLARE_ACCOUNT_ID } : {}),
  assets: { not_found_handling: "single-page-application", run_worker_first: ["/api/*"] },
  observability: { enabled: true },
  triggers: { crons: ["* * * * *"] },
  d1_databases: [{
    binding: "DB",
    database_name: env.D1_DATABASE_NAME || "remote-support-booking",
    database_id: env.D1_DATABASE_ID || "00000000-0000-0000-0000-000000000000",
    migrations_dir: "migrations",
  }],
  send_email: [{ name: "EMAIL", allowed_sender_addresses: [env.MAIL_FROM || "no-reply@example.com"] }],
  vars: {
    APP_BASE_URL: strict ? `https://${domain}` : (env.APP_BASE_URL || "http://localhost:5173"),
    APP_TIMEZONE: env.APP_TIMEZONE || "UTC",
    APP_LOCALE: env.APP_LOCALE || "en",
    ORG_NAME: env.ORG_NAME || "Example Support",
    MAIL_FROM: env.MAIL_FROM || "no-reply@example.com",
    MAIL_FROM_NAME: env.MAIL_FROM_NAME || "Example Support",
    MAIL_MODE: strict ? (env.MAIL_MODE || "cloudflare") : (env.MAIL_MODE || "dev"),
    MAIL_REPLY_FORWARD_TO: env.MAIL_REPLY_FORWARD_TO || "",
    TURNSTILE_SITE_KEY: env.TURNSTILE_SITE_KEY || "",
  },
  ...(strict ? { routes: [{ pattern: domain, custom_domain: true }] } : {}),
};
writeFileSync("wrangler.jsonc", JSON.stringify(config, null, 2) + "\n");
console.log(`wrangler.jsonc written (${strict ? "strict" : "dev defaults"})`);
```

- [ ] **Step 3: `migrations/0001_init.sql`** — the full schema (later plans use every table).

```sql
CREATE TABLE guard (ok INTEGER NOT NULL);
CREATE TABLE schedule_state (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL);
INSERT INTO schedule_state (id, version) VALUES (1, 0);

CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE holidays (date TEXT PRIMARY KEY, name TEXT NOT NULL);

CREATE TABLE staff (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','technician')),
  bookable INTEGER NOT NULL DEFAULT 1,
  notify INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_number TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  phone TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  notes TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE customer_contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  email TEXT NOT NULL COLLATE NOCASE,
  name TEXT,
  phone TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  UNIQUE (customer_id, email)
);
CREATE INDEX idx_contacts_email ON customer_contacts(email);

CREATE TABLE auth_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('customer','staff')),
  email TEXT NOT NULL COLLATE NOCASE,
  redirect_path TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('customer','staff')),
  email TEXT NOT NULL COLLATE NOCASE,
  staff_id INTEGER REFERENCES staff(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE TABLE access_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT NOT NULL UNIQUE,
  reservation_id TEXT NOT NULL REFERENCES reservations(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE availability_windows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('weekly','date')),
  weekday INTEGER CHECK (weekday BETWEEN 0 AND 6),
  date TEXT,
  start_min INTEGER NOT NULL,
  end_min INTEGER NOT NULL CHECK (end_min > start_min)
);
CREATE TABLE availability_window_staff (
  window_id INTEGER NOT NULL REFERENCES availability_windows(id) ON DELETE CASCADE,
  staff_id INTEGER NOT NULL REFERENCES staff(id),
  PRIMARY KEY (window_id, staff_id)
);
CREATE TABLE date_overrides (date TEXT PRIMARY KEY, note TEXT);
CREATE TABLE staff_unavailability (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  staff_id INTEGER NOT NULL REFERENCES staff(id),
  start_at INTEGER NOT NULL,
  end_at INTEGER NOT NULL,
  reason TEXT
);

CREATE TABLE reservations (
  id TEXT PRIMARY KEY,
  ref TEXT NOT NULL UNIQUE,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  contact_email TEXT NOT NULL COLLATE NOCASE,
  contact_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  issue TEXT NOT NULL,
  start_at INTEGER NOT NULL,
  end_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','confirmed','declined','expired','cancelled','completed')),
  assigned_staff_id INTEGER REFERENCES staff(id),
  provisional_staff_id INTEGER REFERENCES staff(id),
  version INTEGER NOT NULL DEFAULT 1,
  replaces_id TEXT REFERENCES reservations(id),
  idempotency_key TEXT NOT NULL UNIQUE,
  approval_reminder_at INTEGER,
  escalation_at INTEGER,
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  confirmed_at INTEGER,
  confirmed_by INTEGER REFERENCES staff(id),
  closed_at INTEGER,
  closed_by_kind TEXT,
  closed_by TEXT,
  close_reason TEXT
);
CREATE INDEX idx_res_status_start ON reservations(status, start_at);
CREATE INDEX idx_res_customer ON reservations(customer_id);

CREATE TABLE proposals (
  id TEXT PRIMARY KEY,
  reservation_id TEXT NOT NULL REFERENCES reservations(id),
  status TEXT NOT NULL CHECK (status IN ('open','accepted','rejected','expired','superseded','withdrawn')),
  message TEXT,
  created_by INTEGER REFERENCES staff(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE TABLE proposal_options (
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL REFERENCES proposals(id),
  start_at INTEGER NOT NULL,
  end_at INTEGER NOT NULL,
  staff_id INTEGER NOT NULL REFERENCES staff(id)
);

CREATE TABLE tech_blocks (
  staff_id INTEGER NOT NULL,
  block_start INTEGER NOT NULL,
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('reservation','option')),
  owner_id TEXT NOT NULL,
  PRIMARY KEY (staff_id, block_start)
);
CREATE INDEX idx_blocks_owner ON tech_blocks(owner_kind, owner_id);

CREATE TABLE email_jobs (
  id TEXT PRIMARY KEY,
  dedupe_key TEXT NOT NULL UNIQUE,
  template TEXT NOT NULL,
  to_email TEXT NOT NULL,
  reservation_id TEXT,
  payload TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL CHECK (status IN ('queued','sending','sent','failed','skipped','cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  send_after INTEGER NOT NULL,
  locked_until INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  sent_at INTEGER
);
CREATE INDEX idx_jobs_due ON email_jobs(status, send_after);

CREATE TABLE dev_mailbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  html TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('customer','staff','system')),
  actor TEXT,
  action TEXT NOT NULL,
  reservation_id TEXT,
  customer_id INTEGER,
  details TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_audit_res ON audit_log(reservation_id);

CREATE TABLE rate_limits (key TEXT PRIMARY KEY, window_start INTEGER NOT NULL, count INTEGER NOT NULL);
```

- [ ] **Step 4: Worker skeleton**

`src/worker/env.ts`:
```ts
export interface Env {
  DB: D1Database;
  EMAIL?: SendEmail;
  ASSETS?: Fetcher;
  APP_BASE_URL: string;
  APP_TIMEZONE: string;
  APP_LOCALE: string;
  ORG_NAME: string;
  MAIL_FROM: string;
  MAIL_FROM_NAME: string;
  MAIL_MODE: "cloudflare" | "dev";
  MAIL_REPLY_FORWARD_TO?: string;
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
  BOOTSTRAP_ADMIN_EMAILS?: string;
}
export interface StaffPrincipal { id: number; email: string; name: string; role: "admin" | "technician" }
export interface Vars { staff?: StaffPrincipal; customerEmail?: string; sessionHash?: string }
export type AppEnv = { Bindings: Env; Variables: Vars };
```

`src/worker/app.ts`:
```ts
import { Hono } from "hono";
import type { AppEnv } from "./env";
export const app = new Hono<AppEnv>().basePath("/api");
app.get("/health", (c) => c.json({ ok: true }));
```

`src/worker/index.ts`:
```ts
import { app } from "./app";
import type { Env } from "./env";
export default {
  fetch: (req, env, ctx) => app.fetch(req, env, ctx),
  async scheduled(_c, _env, _ctx) {},
} satisfies ExportedHandler<Env>;
```

`vite.config.ts`:
```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
export default defineConfig({ plugins: [react(), tailwindcss(), cloudflare()] });
```

`index.html` (root) mounts `/src/web/main.tsx`; `src/web/index.css` = `@import "tailwindcss";`; `App.tsx` renders a placeholder heading from the catalog in Task 11 (for now `<h1>Remote support booking</h1>`).

`tsconfig.json`: `"strict": true`, `"noUncheckedIndexedAccess": true`, `"module": "ESNext"`, `"moduleResolution": "Bundler"`, `"target": "ES2023"`, `"jsx": "react-jsx"`, `"lib": ["ES2023","DOM","DOM.Iterable"]`, `"types": ["@cloudflare/workers-types", "@cloudflare/vitest-pool-workers/types", "vite/client"]`, include `src`, `test`, `e2e`.

- [ ] **Step 5: Test harness**

`vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    plugins: [cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: { bindings: {
        TEST_MIGRATIONS: migrations,
        MAIL_MODE: "dev",
        APP_BASE_URL: "http://localhost:5173",
        APP_TIMEZONE: "Asia/Tokyo",
        BOOTSTRAP_ADMIN_EMAILS: "boot-admin@example.test",
      } },
    })],
    test: { setupFiles: ["./test/setup.ts"], include: ["test/**/*.test.ts"] },
  };
});
```

`test/setup.ts`:
```ts
import { env, reset, applyD1Migrations } from "cloudflare:test";
import { beforeEach } from "vitest";
beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS);
});
```

`test/helpers.ts`:
```ts
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/worker/index";
export const ORIGIN = "http://localhost:5173";
export interface ApiResult<T = any> { status: number; json: T; headers: Headers; setCookie: string[] }
export async function api<T = any>(method: string, path: string, opts: { body?: unknown; cookie?: string; origin?: string | null; xrw?: boolean } = {}): Promise<ApiResult<T>> {
  const headers = new Headers({ "content-type": "application/json" });
  if (opts.origin !== null) headers.set("origin", opts.origin ?? ORIGIN);
  if (opts.xrw !== false) headers.set("x-requested-with", "fetch");
  if (opts.cookie) headers.set("cookie", opts.cookie);
  const ctx = createExecutionContext();
  const res = await worker.fetch!(new Request(`${ORIGIN}${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) }) as any, env as any, ctx);
  await waitOnExecutionContext(ctx);
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null, headers: res.headers, setCookie: res.headers.getSetCookie() };
}
export function cookieFrom(setCookie: string[]): string { return setCookie.map((c) => c.split(";")[0]).join("; "); }
```

- [ ] **Step 6: Failing test `test/health.test.ts`**

```ts
import { it, expect } from "vitest";
import { api } from "./helpers";
it("health", async () => {
  const r = await api("GET", "/api/health");
  expect(r.status).toBe(200);
  expect(r.json).toEqual({ ok: true });
});
```

Run `npm test` → PASS after the skeleton exists (run once before creating `app.ts` to see it fail).

- [ ] **Step 7: Repo hygiene files**

- `.gitignore`: `node_modules`, `dist`, `.wrangler`, `wrangler.jsonc`, `.env`, `.dev.vars`, `test-results`, `playwright-report`, `*.local`.
- `.env.example`: every variable in spec §2 with an `example.com` value and a one-line comment; note "In production these live in your secret manager (e.g. Doppler) and are injected with `doppler run -- npm run deploy`."
- `.gitleaks.toml`: `[extend] useDefault = true`.
- `LICENSE`: MIT, copyright line `Copyright (c) 2026 Remote Support Booking contributors`.
- `docs/sample-customers.csv`:
  ```
  customer_number,name,phone,contact_email,contact_name,active
  C-1001,Example Dental Clinic,+1-555-0100,frontdesk@example.test,Jamie Doe,true
  C-1001,Example Dental Clinic,+1-555-0100,manager@example.test,Riley Roe,true
  C-1002,Sample Eye Care,+1-555-0101,office@example.test,Sam Poe,true
  C-1003,Demo Family Practice,,shared@example.test,Alex Moe,true
  C-1004,Demo Family Practice West,,shared@example.test,Alex Moe,true
  C-1005,Inactive Example Co,,former@example.test,Pat Loe,false
  ```
- `.github/workflows/ci.yml`: on push/PR → checkout, setup-node 22, `npm ci`, gitleaks (`gitleaks/gitleaks-action@v2`), `npm run typecheck`, `npm test`. No secrets used.
- `README.md` (generic): a **Tech stack** section stating the app runs entirely on Cloudflare, with a table: Frontend — React + Vite (served as Workers Static Assets) · Backend — Cloudflare Workers + Hono · Database — Cloudflare D1 · Email — Cloudflare Email Service (`send_email`) + Email Routing for replies · Scheduled jobs — Workers Cron Triggers · Bot protection — Cloudflare Turnstile · Domain — Workers custom domain; plus a **Configuration & secrets** section stating that every deployment-specific value and secret is supplied via environment variables and that the reference deployment keeps them in **Doppler** (`doppler run -- npm run deploy`), with any other secret manager or a local `.env` also working. Then: what it is (remote-support appointment requests for small service teams; customers request via magic link, staff approve and assign a technician; the session itself is a phone call + your remote-access tool), who it's for, feature list (from spec §1), how it works (diagram of the flow: request → pending (capacity held) → approve/assign → confirmed → reminders), tech stack, quick start (`cp .env.example .env`, `npm i`, `npm run dev`, `npm run seed`, open `http://localhost:5173`, dev mailbox at `/dev/mail`), configuration table (vars from spec §2), deployment pointer to `docs/SETUP.md` (written in Plan 4), security notes, licence. No organisation-specific names.

- [ ] **Step 8: Verify and commit**

Run: `npm run typecheck && npm test` → PASS. `npx vite build` → succeeds.
```bash
git add -A && git commit -m "chore: scaffold worker, SPA, schema, test harness, CI and README"
```

---

### Task 2: Time and business hours (domain)

**Files:** Create `src/domain/time.ts`, `src/domain/business-hours.ts`, `src/domain/settings.ts`; Test `test/domain/business-hours.test.ts`, `test/domain/time.test.ts`

**Interfaces — Produces:**
```ts
// time.ts
export function wallToUtc(date: string, minuteOfDay: number, tz: string): number;   // epoch ms
export function utcToWall(ms: number, tz: string): { date: string; minute: number; weekday: number }; // weekday 0=Sun
export function addDays(date: string, n: number): string;                            // 'YYYY-MM-DD'
export function eachDate(from: string, to: string): string[];                        // inclusive
export const MIN = 60_000;
// settings.ts
export type BusinessHours = Array<{ start: number; end: number } | null>; // length 7, index 0=Sunday, minutes
export interface Settings { orgName: string; supportPhone: string; remoteToolName: string; customerInstructions: string;
  durationMin: number; bufferBeforeMin: number; bufferAfterMin: number; slotStepMin: number;
  minNoticeBh: number; bookingHorizonDays: number; cancelCutoffMin: number; maxActivePerAccount: number;
  businessHours: BusinessHours; approvalReminderBh: number; approvalEscalationBh: number; approvalExpiryBh: number;
  expiryBeforeStartMin: number; proposalExpiryBh: number; proposalExpiryBeforeStartMin: number;
  customerReminderOffsetsMin: number[]; notifyCustomerOnReassign: boolean }
export const DEFAULT_SETTINGS: Settings; // values from spec §9; businessHours Mon–Fri {start:540,end:1080}
// business-hours.ts
export interface BhCtx { tz: string; hours: BusinessHours; holidays: Set<string> }
export function addBusinessMinutes(fromMs: number, minutes: number, ctx: BhCtx): number;
```

- [ ] **Step 1: Failing tests**

```ts
// test/domain/business-hours.test.ts
import { describe, it, expect } from "vitest";
import { addBusinessMinutes } from "../../src/domain/business-hours";
import { wallToUtc } from "../../src/domain/time";
import { DEFAULT_SETTINGS } from "../../src/domain/settings";
const tz = "Asia/Tokyo";
const ctx = { tz, hours: DEFAULT_SETTINGS.businessHours, holidays: new Set<string>(["2026-10-12"]) };
const at = (d: string, hh: number, mm = 0) => wallToUtc(d, hh * 60 + mm, tz);
describe("addBusinessMinutes", () => {
  it("within the same day", () => expect(addBusinessMinutes(at("2026-10-01", 10), 120, ctx)).toBe(at("2026-10-01", 12)));
  it("rolls overnight", () => expect(addBusinessMinutes(at("2026-10-01", 17), 120, ctx)).toBe(at("2026-10-02", 10)));
  it("starts before opening", () => expect(addBusinessMinutes(at("2026-10-01", 6), 60, ctx)).toBe(at("2026-10-01", 10)));
  it("skips weekend (Fri 17:00 + 3h → Mon 11:00)", () => expect(addBusinessMinutes(at("2026-10-02", 17), 180, ctx)).toBe(at("2026-10-05", 11)));
  it("skips holiday (Fri 18:00 + 60 → Tue 10:00 when Mon is holiday)", () => expect(addBusinessMinutes(at("2026-10-09", 18), 60, ctx)).toBe(at("2026-10-13", 10)));
  it("zero minutes returns input", () => expect(addBusinessMinutes(at("2026-10-03", 3), 0, ctx)).toBe(at("2026-10-03", 3)));
});
```

```ts
// test/domain/time.test.ts
import { it, expect } from "vitest";
import { wallToUtc, utcToWall, addDays, eachDate } from "../../src/domain/time";
it("Tokyo wall time", () => expect(new Date(wallToUtc("2026-10-01", 600, "Asia/Tokyo")).toISOString()).toBe("2026-10-01T01:00:00.000Z"));
it("DST zone", () => expect(new Date(wallToUtc("2026-07-01", 600, "America/New_York")).toISOString()).toBe("2026-07-01T14:00:00.000Z"));
it("roundtrip", () => expect(utcToWall(Date.parse("2026-10-04T01:30:00Z"), "Asia/Tokyo")).toEqual({ date: "2026-10-04", minute: 630, weekday: 0 }));
it("dates", () => { expect(addDays("2026-12-31", 1)).toBe("2027-01-01"); expect(eachDate("2026-10-01", "2026-10-03")).toEqual(["2026-10-01","2026-10-02","2026-10-03"]); });
```

- [ ] **Step 2:** `npm test -- test/domain` → FAIL (modules missing).

- [ ] **Step 3: Implement**

`time.ts` uses `TZDate` from `@date-fns/tz`:
```ts
import { TZDate } from "@date-fns/tz";
export const MIN = 60_000;
export function wallToUtc(date: string, minuteOfDay: number, tz: string): number {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new TZDate(y, m - 1, d, Math.floor(minuteOfDay / 60), minuteOfDay % 60, 0, tz).getTime();
}
export function utcToWall(ms: number, tz: string) {
  const t = new TZDate(ms, tz);
  const date = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
  return { date, minute: t.getHours() * 60 + t.getMinutes(), weekday: t.getDay() };
}
export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10);
}
export function eachDate(from: string, to: string): string[] {
  const out: string[] = []; for (let d = from; d <= to; d = addDays(d, 1)) out.push(d); return out;
}
```

`business-hours.ts`:
```ts
import { utcToWall, wallToUtc, addDays, MIN } from "./time";
import type { BusinessHours } from "./settings";
export interface BhCtx { tz: string; hours: BusinessHours; holidays: Set<string> }
export function addBusinessMinutes(fromMs: number, minutes: number, ctx: BhCtx): number {
  if (minutes <= 0) return fromMs;
  let remaining = minutes;
  let { date } = utcToWall(fromMs, ctx.tz);
  for (let i = 0; i < 800; i++, date = addDays(date, 1)) {
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    const h = ctx.hours[weekday];
    if (!h || ctx.holidays.has(date)) continue;
    const open = wallToUtc(date, h.start, ctx.tz), close = wallToUtc(date, h.end, ctx.tz);
    const start = Math.max(open, fromMs);
    if (start >= close) continue;
    const avail = (close - start) / MIN;
    if (avail >= remaining) return start + remaining * MIN;
    remaining -= avail;
  }
  throw new Error("business hours misconfigured: no open time within 800 days");
}
```

`settings.ts` holds `DEFAULT_SETTINGS` exactly per spec §9 (`orgName: "Example Support"`, `supportPhone: ""`, `remoteToolName: "TeamViewer"`, `customerInstructions: ""`, `businessHours: [null, w, w, w, w, w, null]` with `w = { start: 540, end: 1080 }`).

- [ ] **Step 4:** `npm test -- test/domain` → PASS.
- [ ] **Step 5:** Commit `feat(domain): timezone helpers, business hours, settings defaults`.

---

### Task 3: Slot generation (domain)

**Files:** Create `src/domain/slots.ts`; Test `test/domain/slots.test.ts`

**Interfaces — Produces:**
```ts
export interface WindowDef { id: number; kind: "weekly" | "date"; weekday: number | null; date: string | null; startMin: number; endMin: number; staffIds: number[] }
export interface Unavail { staffId: number; startAt: number; endAt: number }
export interface SlotCfg { tz: string; durationMin: number; stepMin: number; bufferBeforeMin: number; bufferAfterMin: number }
export interface Slot { startAt: number; endAt: number; staffIds: number[] } // sorted ascending staffIds
export interface SlotInput { fromDate: string; toDate: string; windows: WindowDef[]; overrideDates: Set<string>; holidays: Set<string>; unavailability: Unavail[]; bookableStaff: Set<number>; cfg: SlotCfg }
export function generateSlots(input: SlotInput): Slot[];                     // sorted by startAt
export function occupiedRange(startAt: number, endAt: number, cfg: Pick<SlotCfg, "bufferBeforeMin" | "bufferAfterMin">): [number, number];
export function blockMinutes(startAt: number, endAt: number, cfg: Pick<SlotCfg, "bufferBeforeMin" | "bufferAfterMin">): number[]; // epoch minutes, 5-min grid
export function findSlot(slots: Slot[], startAt: number): Slot | undefined;
```

Rules: for each date in range — if `overrideDates.has(date)` use only `kind='date'` windows with that date; else if holiday → none; else weekly windows whose weekday matches. Slot starts at `startMin + k*stepMin` while `start + durationMin <= endMin`. Staff eligible = window staff ∩ bookableStaff minus anyone with unavailability overlapping `occupiedRange`. Slots at the same `startAt` from multiple windows merge staff (union). Drop slots with zero staff. `blockMinutes`: from `floor(occStart/5min)*5` to `< occEnd` step 5, in epoch minutes (`ms / 60000`).

- [ ] **Step 1: Failing tests**

```ts
import { it, expect } from "vitest";
import { generateSlots, blockMinutes, occupiedRange } from "../../src/domain/slots";
import { wallToUtc } from "../../src/domain/time";
const tz = "Asia/Tokyo";
const cfg = { tz, durationMin: 30, stepMin: 30, bufferBeforeMin: 0, bufferAfterMin: 10 };
const base = { holidays: new Set<string>(), overrideDates: new Set<string>(), unavailability: [], bookableStaff: new Set([1, 2, 3, 4]), cfg };
const w = (o: Partial<any>) => ({ id: 1, kind: "weekly", weekday: 4, date: null, startMin: 600, endMin: 660, staffIds: [1, 2], ...o });
it("weekly window yields two 30-min slots on Thursday 2026-10-01", () => {
  const s = generateSlots({ ...base, fromDate: "2026-10-01", toDate: "2026-10-01", windows: [w({})] });
  expect(s.map((x) => x.startAt)).toEqual([wallToUtc("2026-10-01", 600, tz), wallToUtc("2026-10-01", 630, tz)]);
  expect(s[0]!.staffIds).toEqual([1, 2]);
});
it("override replaces weekly; holiday closes", () => {
  const ov = generateSlots({ ...base, fromDate: "2026-10-01", toDate: "2026-10-01", overrideDates: new Set(["2026-10-01"]), windows: [w({}), w({ id: 2, kind: "date", weekday: null, date: "2026-10-01", startMin: 840, endMin: 870, staffIds: [3] })] });
  expect(ov).toHaveLength(1); expect(ov[0]!.staffIds).toEqual([3]);
  expect(generateSlots({ ...base, fromDate: "2026-10-01", toDate: "2026-10-01", holidays: new Set(["2026-10-01"]), windows: [w({})] })).toHaveLength(0);
});
it("unavailability removes staff incl. buffer; merges windows", () => {
  const start = wallToUtc("2026-10-01", 630, tz);
  const s = generateSlots({ ...base, fromDate: "2026-10-01", toDate: "2026-10-01", windows: [w({}), w({ id: 3, staffIds: [3] })],
    unavailability: [{ staffId: 2, startAt: start + 35 * 60000, endAt: start + 60 * 60000 }] });
  expect(s[0]!.staffIds).toEqual([1, 2, 3]);
  expect(s[1]!.staffIds).toEqual([1, 3]); // 10:30 slot occupies until 11:10 → overlaps 11:05
});
it("blocks cover duration + buffers on 5-min grid", () => {
  const st = Date.parse("2026-10-01T01:00:00Z");
  expect(occupiedRange(st, st + 30 * 60000, cfg)).toEqual([st, st + 40 * 60000]);
  expect(blockMinutes(st, st + 30 * 60000, cfg)).toHaveLength(8);
});
```

- [ ] **Step 2:** run → FAIL. **Step 3:** implement per rules. **Step 4:** run → PASS. **Step 5:** commit `feat(domain): slot generation and technician blocks`.

---

### Task 4: Technician matching (domain)

**Files:** Create `src/domain/matching.ts`; Test `test/domain/matching.test.ts`

**Interfaces — Produces:**
```ts
export interface Hold { id: string; start: number; end: number; fixed: number | null; eligible: number[]; preferred: number | null }
// start/end = OCCUPIED range (buffers included). fixed = confirmed/option technician. eligible used when fixed is null.
export function solve(holds: Hold[]): Map<string, number> | null;
export function component(holds: Hold[], start: number, end: number): Hold[]; // holds transitively overlapping [start,end)
export function spotsFor(existing: Hold[], slot: { start: number; end: number; eligible: number[] }): number;
export function assignableFor(existing: Hold[], targetId: string): number[]; // staff s ∈ target.eligible such that fixing target→s keeps solve() non-null
```

Algorithm (`solve`): backtracking list-colouring. Order: fixed holds first (validate no two fixed holds share staff while overlapping → return null), then flexible holds sorted by `(eligible.length, start)`. For each flexible hold try `preferred` first, then the other eligible staff ascending; a staff is usable if no already-assigned hold with that staff overlaps (`a.start < b.end && b.start < a.end`). Node budget 200 000 → return null (conservative). Returns assignment for every hold.

`spotsFor`: `k` from 0 up to `slot.eligible.length`; add `k` synthetic holds `{id:"__new"+i, fixed:null, eligible: slot.eligible, preferred:null}`; return the largest `k` for which `solve(component(existing ∪ synthetic))` succeeds (stop at first failure).

`assignableFor`: for each `s` in target.eligible (ascending), clone holds with target `fixed = s`; keep `s` if `solve(component(...))` non-null.

- [ ] **Step 1: Failing tests** (spec §4 examples + the identity case)

```ts
import { describe, it, expect } from "vitest";
import { solve, spotsFor, assignableFor } from "../../src/domain/matching";
const M = 60_000, T = 1_000_000 * M;
const slot = (startMin: number, eligible: number[]) => ({ start: T + startMin * M, end: T + (startMin + 40) * M, eligible });
const hold = (id: string, startMin: number, o: Partial<{ fixed: number | null; eligible: number[]; preferred: number | null }>) =>
  ({ id, start: T + startMin * M, end: T + (startMin + 40) * M, fixed: null, eligible: [1, 2], preferred: null, ...o });
describe("capacity examples (slot 10:00 with A=1, B=2)", () => {
  it("no requests → 2", () => expect(spotsFor([], slot(0, [1, 2]))).toBe(2));
  it("one pending → 1", () => expect(spotsFor([hold("p", 0, {})], slot(0, [1, 2]))).toBe(1));
  it("confirmed(A) + pending → 0", () => expect(spotsFor([hold("c", 0, { fixed: 1 }), hold("p", 0, {})], slot(0, [1, 2]))).toBe(0));
  it("B busy at 10:15 elsewhere + pending → 0", () => expect(spotsFor([hold("x", 15, { fixed: 2, eligible: [2] }), hold("p", 0, {})], slot(0, [1, 2]))).toBe(0));
});
it("pending provisional moves to make room", () => {
  // pending P eligible [1,2] currently on 1; new slot only has staff 1 → P must move to 2
  expect(spotsFor([hold("p", 0, { preferred: 1 })], slot(0, [1]))).toBe(1);
  const sol = solve([hold("p", 0, { preferred: 1 }), hold("n", 0, { eligible: [1] })])!;
  expect(sol.get("p")).toBe(2); expect(sol.get("n")).toBe(1);
});
it("overlap across adjacent slots via buffer", () => {
  // 10:00–10:40 occupied and 10:30 slot overlap for same tech
  expect(spotsFor([hold("c", 0, { fixed: 1, eligible: [1] })], slot(30, [1]))).toBe(0);
  expect(spotsFor([hold("c", 0, { fixed: 1, eligible: [1] })], slot(40, [1]))).toBe(1);
});
it("assignableFor excludes techs needed by other pending", () => {
  const holds = [hold("t", 0, {}), hold("q", 0, { eligible: [2] })];
  expect(assignableFor(holds, "t")).toEqual([1]);
});
it("conflicting fixed holds → null", () => expect(solve([hold("a", 0, { fixed: 1 }), hold("b", 10, { fixed: 1 })])).toBeNull());
```

- [ ] **Step 2–4:** fail → implement → pass.
- [ ] **Step 5:** commit `feat(domain): technician-identity matching for capacity`.

---

### Task 5: Deadlines and reservation reference (domain)

**Files:** Create `src/domain/deadlines.ts`, `src/domain/ref.ts`; Test `test/domain/deadlines.test.ts`

**Interfaces — Produces:**
```ts
export function approvalDeadlines(createdAt: number, startAt: number, s: Settings, bh: BhCtx): { reminderAt: number; escalationAt: number; expiresAt: number };
export function minNoticeAt(now: number, s: Settings, bh: BhCtx): number; // addBusinessMinutes(now, minNoticeBh*60)
export function newRef(): string;      // "R-XXXX-XXXX", alphabet 23456789ABCDEFGHJKMNPQRSTUVWXYZ, crypto.getRandomValues
```
Rules (spec §6.2): `expiresAt = min(created + approvalExpiryBh BH, start − expiryBeforeStartMin)`; `reminderAt = min(created + approvalReminderBh BH, expiresAt − 30 min)`; `escalationAt = min(created + approvalEscalationBh BH, expiresAt − 30 min)`; each clamped to `≥ createdAt`.

- [ ] **Step 1: Failing tests**

```ts
import { it, expect } from "vitest";
import { approvalDeadlines } from "../../src/domain/deadlines";
import { newRef } from "../../src/domain/ref";
import { DEFAULT_SETTINGS as S } from "../../src/domain/settings";
import { wallToUtc } from "../../src/domain/time";
const tz = "Asia/Tokyo", bh = { tz, hours: S.businessHours, holidays: new Set<string>() };
const at = (d: string, h: number) => wallToUtc(d, h * 60, tz);
it("normal weekday request", () => {
  const r = approvalDeadlines(at("2026-10-01", 10), at("2026-10-05", 15), S, bh);
  expect(r.reminderAt).toBe(at("2026-10-01", 12));
  expect(r.escalationAt).toBe(at("2026-10-01", 14));
  expect(r.expiresAt).toBe(at("2026-10-01", 18));         // 10:00 + 8 BH = 18:00 same day (exactly at close)
});
it("near-start request expires one hour before start", () => {
  const r = approvalDeadlines(at("2026-10-01", 10), at("2026-10-01", 14), S, bh);
  expect(r.expiresAt).toBe(at("2026-10-01", 13));
  expect(r.escalationAt).toBe(at("2026-10-01", 12) + 30 * 60000); // clamped to expires − 30m
});
it("ref format", () => expect(newRef()).toMatch(/^R-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/));
```

- [ ] **Step 2–4:** fail → implement → pass. **Step 5:** commit `feat(domain): approval deadlines and reservation refs`.

---

### Task 6: Worker infrastructure — security, sessions plumbing, rate limits, settings repo

**Files:** Create `src/worker/lib/crypto.ts`, `lib/clock.ts`, `lib/http.ts`, `lib/db.ts`, `lib/rate-limit.ts`, `lib/turnstile.ts`, `middleware/security.ts`, `repos/settings.ts`; Modify `src/worker/app.ts`; Test `test/worker/security.test.ts`, `test/worker/db-guard.test.ts`

**Interfaces — Produces:**
```ts
// crypto.ts
export function randomToken(): string;               // 32 random bytes, base64url
export async function sha256Hex(s: string): Promise<string>;
export function uuid(): string;                       // crypto.randomUUID()
// clock.ts — overridable in tests
export const clock: { now: () => number };
export function setNow(ms: number | null): void;      // null → real time
// http.ts
export class HttpError extends Error { constructor(public status: number, public code: string, public details?: unknown) }
export const errorHandler: (err: Error, c: Context) => Response; // HttpError → {error:code, details}; ZodError → 400 {error:"invalid", details}; else 500 {error:"internal"} (logs message only)
// db.ts
export function assertSql(db: D1Database, existsSql: string, ...binds: unknown[]): D1PreparedStatement;
//   → INSERT INTO guard(ok) SELECT NULL WHERE NOT EXISTS (<existsSql>)   (fails with NOT NULL when condition false)
export function scheduleVersionGuard(db: D1Database, version: number): D1PreparedStatement;
export function bumpScheduleVersion(db: D1Database): D1PreparedStatement;
export async function readScheduleVersion(db: D1Database): Promise<number>;
export function isRetryableBatchError(e: unknown): boolean; // message includes "NOT NULL constraint failed: guard.ok" or "UNIQUE constraint failed: tech_blocks"
export async function withRetry<T>(fn: () => Promise<T>, attempts?: number): Promise<T>; // retries isRetryableBatchError up to 5
export function audit(db: D1Database, e: { actorKind: "customer"|"staff"|"system"; actor: string | null; action: string; reservationId?: string | null; customerId?: number | null; details?: unknown }): D1PreparedStatement;
// rate-limit.ts
export async function rateLimit(db: D1Database, key: string, limit: number, windowMs: number): Promise<boolean>; // true = allowed
// turnstile.ts
export async function verifyTurnstile(env: Env, token: string | undefined, ip: string | null): Promise<boolean>; // true if no secret configured
// settings repo
export async function getSettings(db: D1Database, env: Env): Promise<Settings>; // DEFAULT_SETTINGS ← ORG_NAME env ← DB rows (key = Settings field name, value JSON)
export async function getHolidays(db: D1Database): Promise<Set<string>>;
export async function bhCtx(db: D1Database, env: Env, s?: Settings): Promise<BhCtx>;
```

Security middleware (mounted on `/api/*`):
- Sets `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`.
- For non-GET/HEAD: reject with 403 `{error:"csrf"}` unless `Origin === new URL(env.APP_BASE_URL).origin` **and** `X-Requested-With === "fetch"`.

- [ ] **Step 1: Failing tests**

```ts
// test/worker/security.test.ts
import { it, expect } from "vitest";
import { api } from "../helpers";
it("POST without Origin is rejected", async () => expect((await api("POST", "/api/auth/logout", { origin: null })).status).toBe(403));
it("POST with foreign Origin is rejected", async () => expect((await api("POST", "/api/auth/logout", { origin: "https://evil.example" })).status).toBe(403));
it("POST without X-Requested-With is rejected", async () => expect((await api("POST", "/api/auth/logout", { xrw: false })).status).toBe(403));
it("security headers", async () => { const r = await api("GET", "/api/health"); expect(r.headers.get("referrer-policy")).toBe("no-referrer"); });
```
(`/api/auth/logout` is added in Task 7; until then expect 403 from the middleware regardless — the test is valid now.)

```ts
// test/worker/db-guard.test.ts
import { env } from "cloudflare:test";
import { it, expect } from "vitest";
import { assertSql, scheduleVersionGuard, bumpScheduleVersion, readScheduleVersion, isRetryableBatchError } from "../../src/worker/lib/db";
it("stale schedule version aborts the whole batch", async () => {
  const v = await readScheduleVersion(env.DB);
  await env.DB.batch([scheduleVersionGuard(env.DB, v), bumpScheduleVersion(env.DB)]);
  const err = await env.DB.batch([scheduleVersionGuard(env.DB, v), env.DB.prepare("INSERT INTO holidays VALUES ('2026-01-01','x')"), bumpScheduleVersion(env.DB)]).catch((e) => e);
  expect(isRetryableBatchError(err)).toBe(true);
  expect(await env.DB.prepare("SELECT count(*) c FROM holidays").first("c")).toBe(0);
  expect(await readScheduleVersion(env.DB)).toBe(v + 1);
});
it("assertSql passes when condition holds", async () => {
  await env.DB.batch([assertSql(env.DB, "SELECT 1 FROM schedule_state WHERE id = ?", 1)]);
  expect(await env.DB.prepare("SELECT count(*) c FROM guard").first("c")).toBe(0);
});
```

- [ ] **Step 2–4:** fail → implement → pass. Rate limit implementation: `INSERT INTO rate_limits(key, window_start, count) VALUES (?, ?, 1) ON CONFLICT(key) DO UPDATE SET count = CASE WHEN window_start <= ?3 THEN 1 ELSE count + 1 END, window_start = CASE WHEN window_start <= ?3 THEN ?2 ELSE window_start END RETURNING count` where `?3 = now − windowMs`; allowed if `count <= limit`.
- [ ] **Step 5:** commit `feat(worker): security middleware, atomic batch guards, rate limits, settings`.

---

### Task 7: Authentication — magic links, sessions, bootstrap admin

**Files:** Create `src/worker/middleware/session.ts`, `src/worker/auth/routes.ts`, `src/worker/repos/staff.ts`, `src/worker/repos/customers.ts`; Modify `src/worker/app.ts`; Test `test/worker/auth.test.ts`

Depends on the outbox from Task 8 for sending; in this task, `enqueueEmail` is called — implement Task 8's `enqueueEmail` signature as a stub here first if executing out of order. **Execute Task 8 before Task 7** (order in the plan: do Task 8 first). The tests below read the dev mailbox via `processOutbox`.

**Interfaces:**
- Consumes: `enqueueEmail`, `processOutbox` (Task 8), `rateLimit`, `verifyTurnstile`, `sha256Hex`, `randomToken`, `clock`.
- Produces:
```ts
// repos/customers.ts
export async function eligibleAccountsForEmail(db: D1Database, email: string): Promise<Array<{ id: number; customerNumber: string; name: string; contactName: string | null; contactPhone: string | null; customerPhone: string | null }>>; // active contact AND active customer
export async function accountIdsForContact(db: D1Database, email: string): Promise<number[]>; // any contact row (active or not) — for viewing/cancelling
// repos/staff.ts
export async function activeStaffByEmail(db: D1Database, email: string): Promise<StaffPrincipal | null>;
export async function ensureBootstrapAdmin(db: D1Database, env: Env, email: string): Promise<void>; // creates admin only if no active admin exists and email ∈ BOOTSTRAP_ADMIN_EMAILS (case-insensitive)
export async function notifyStaff(db: D1Database): Promise<Array<{ id: number; email: string; name: string }>>; // active && notify
// session middleware
export const loadSession: MiddlewareHandler<AppEnv>; // reads __Host-cust / __Host-staff cookies, validates rows by kind, not revoked/expired; sets c.var.customerEmail / c.var.staff; staff sliding expiry refresh
export function requireCustomer(): MiddlewareHandler<AppEnv>;          // 401 {error:"auth_required"}
export function requireStaff(role?: "admin"): MiddlewareHandler<AppEnv>; // 401 / 403 {error:"forbidden"}
export async function createSession(c: Context<AppEnv>, kind: "customer" | "staff", email: string, staffId: number | null): Promise<void>; // sets cookie
```
- Routes:
  - `POST /api/auth/customer/request {email, turnstileToken?, redirectPath?}` → always `200 {ok:true}`. Rate-limit `login:email:<email>` 3/15min and `login:ip:<ip>` 20/15min (silently drop when exceeded, still 200). If eligible: `enqueueEmail({template:"customer_login", to: email, dedupeKey: "login:"+uuid(), payload:{ redirectPath }})`.
  - `POST /api/auth/staff/request {email, turnstileToken?, redirectPath?}` → same; first `ensureBootstrapAdmin`; if active staff → `staff_login`.
  - `POST /api/auth/redeem {token}` → look up `sha256(token)`: missing → 400 `{error:"invalid_link"}`; used or expired → 410 `{error:"expired_link", kind}`; else mark used (`UPDATE … SET used_at=? WHERE id=? AND used_at IS NULL`, require `changes===1`, else 410), re-check eligibility (customer: ≥1 eligible account; staff: active staff) else 403 `{error:"not_eligible"}`; create session; `200 {kind, redirectPath}`. Rate-limit `redeem:ip` 30/15min → 429.
  - `POST /api/auth/resend {token}` → find token row by hash regardless of state; if found, re-run the matching request flow for its email/kind/redirectPath; always 200.
  - `POST /api/auth/logout {kind:"customer"|"staff"}` → revoke that session row, clear cookie, 200.
  - `GET /api/auth/me` → `{ customer: { email } | null, staff: StaffPrincipal | null, turnstileSiteKey, orgName, timezone }`.
- Cookies: `__Host-cust` (24 h) / `__Host-staff` (14 days, refreshed when < 7 days remain); `HttpOnly; Secure; SameSite=Lax; Path=/`. Value = raw session token; DB stores `sha256`.
- Magic-link tokens: created **at send time** by the outbox renderer (Task 8) — `customer_login`/`staff_login` templates insert `auth_tokens` (15 min) and embed `${APP_BASE_URL}/auth/verify#t=<token>` (customer) or `/staff/auth/verify#t=<token>` (staff).

- [ ] **Step 1: Failing tests** — `test/worker/auth.test.ts` (write a local helper `seedCustomer(email, active=true)` / `seedStaff(email, role)` inserting rows directly, and `lastMailTo(email)` that runs `processOutbox(env, 50)` then reads `dev_mailbox` and extracts the token with `/#t=([A-Za-z0-9_-]+)/`).

Cases (each an `it`):
1. Unknown email → 200 neutral, no mail.
2. Eligible email → 200, mail contains `/auth/verify#t=`; redeem → 200 `{kind:"customer"}` and sets `__Host-cust`.
3. Reusing the same token → 410 `expired_link`.
4. Expired token (`setNow(+16 min)`) → 410; `POST /api/auth/resend` with it → new mail.
5. Customer token cannot open staff routes: customer cookie → `GET /api/staff/me` = 401.
6. Staff email requesting **customer** link (not a contact) → no mail.
7. Bootstrap: `boot-admin@example.test` requests staff link with empty staff table → admin row created, mail sent; after an admin exists, a second bootstrap address (`BOOTSTRAP_ADMIN_EMAILS` contains only one; insert another admin first) → no new admin.
8. Inactive customer (contact active, customer inactive) → no mail; deactivated after link sent → redeem 403.
9. Rate limit: 4th request for same email within 15 min sends no 4th email.
10. Logout revokes: after logout, `GET /api/auth/me` shows `customer: null`.

Add `GET /api/staff/me` (requireStaff) returning the principal in this task.

- [ ] **Step 2–4:** fail → implement → pass.
- [ ] **Step 5:** commit `feat(auth): passwordless customer and staff sessions with bootstrap admin`.

---

### Task 8: Email outbox, adapters, templates, i18n catalog

(Execute before Task 7.)

**Files:** Create `src/shared/i18n/en.ts`, `src/shared/i18n/i18n.ts`, `src/worker/mail/layout.ts`, `src/worker/mail/templates.ts`, `src/worker/mail/adapters.ts`, `src/worker/mail/outbox.ts`, `src/worker/dev/routes.ts`; Modify `src/worker/index.ts` (scheduled → `processOutbox`), `src/worker/app.ts`; Test `test/worker/outbox.test.ts`

**Interfaces — Produces:**
```ts
// i18n
export type Catalog = typeof en;
export function t(key: string, params?: Record<string, string | number>): string; // dot path, {name} interpolation; missing key → key
export function fmtDateTime(ms: number, tz: string, locale: string): string; // e.g. "Thu, Oct 1, 2026, 10:00"
export function tzLabel(tz: string, atMs: number, locale: string): string;    // "Asia/Tokyo (GMT+9)"
// outbox
export type TemplateName = "customer_login" | "staff_login" | "request_received" | "new_request" | "confirmed" | "assigned" | "declined";
export function enqueueEmail(db: D1Database, j: { template: TemplateName; to: string; dedupeKey: string; reservationId?: string | null; payload?: Record<string, unknown>; sendAfter?: number }): D1PreparedStatement; // INSERT OR IGNORE
export async function processOutbox(env: Env, limit?: number): Promise<{ sent: number; failed: number; skipped: number }>;
export function kickOutbox(c: { env: Env; executionCtx: ExecutionContext }): void; // ctx.waitUntil(processOutbox(env, 20))
// adapters
export interface Mailer { send(m: { to: string; subject: string; html: string; text: string }): Promise<void> }
export function mailerFor(env: Env): Mailer; // dev → INSERT dev_mailbox; cloudflare → env.EMAIL.send({from:{email:MAIL_FROM,name:MAIL_FROM_NAME}, to, subject, html, text})
// templates
export interface Rendered { subject: string; html: string; text: string }
export async function renderJob(env: Env, job: EmailJobRow): Promise<Rendered | "skip">;
```

Template data is loaded **at send time** from the DB (reservation, customer, staff names, settings). Preconditions: `request_received` → status ∈ {pending, confirmed}; `new_request` → pending; `confirmed`/`assigned` → confirmed; `declined` → declined. Otherwise `skip`.

Customer-facing reservation emails mint an access token at render time (`access_tokens`, expires `end_at + 14 days`) and link `${APP_BASE_URL}/r#t=<token>`; `cancelUrl` is the same page with `&action=cancel`. Staff emails link `${APP_BASE_URL}/staff/r/<id>`, `?action=approve&assign=me`, `?action=approve`, `?action=propose`.

Email layout (`layout.ts`): table-based, max-width 560px, system font stack, header with org name, one primary button style (`display:inline-block;padding:14px 24px;border-radius:8px;font-size:16px;font-weight:600;background:#1d4ed8;color:#fff;text-decoration:none`) and a secondary link style; footer "You received this because …". All interpolated values HTML-escaped (`escapeHtml`). Plain-text alternative lists the same facts and URLs.

Catalog `en.ts` content (subjects and bodies) — include at minimum:
```ts
export const en = {
  common: { timezone: "Time zone", reference: "Reference", status: "Status", account: "Account", viewReservation: "View reservation", cancelReservation: "Cancel reservation" },
  status: { pending: "Pending approval — not yet confirmed", confirmed: "Confirmed", declined: "Declined", expired: "Expired", cancelled: "Cancelled", completed: "Completed" },
  email: {
    customerLogin: { subject: "Your link to book remote support", button: "Book a remote support session", body: "Use the button below to book a remote support session. The link expires in 15 minutes and can be used once.", ignore: "If you didn't request this, you can ignore this email." },
    staffLogin: { subject: "Sign in to {org} scheduling", button: "Sign in", body: "This sign-in link expires in 15 minutes." },
    requestReceived: { subject: "Request received — not yet confirmed ({ref})", intro: "Your reservation request has been received. Your appointment is not yet confirmed. We will email you once our technical-service team has reviewed it." },
    newRequest: { subject: "New remote support request {ref} — {when}", approveMe: "Approve & assign to me", approve: "Approve / assign…", propose: "Propose another time", details: "Open details" },
    confirmed: { subject: "Confirmed: remote support on {when} ({ref})", intro: "Your remote support appointment is confirmed.", call: "A technician will telephone you at {phone} at the appointment time. Please have your computer turned on and {tool} ready." },
    assigned: { subject: "{ref} confirmed — assigned to {tech}", intro: "{approver} approved this request and assigned {tech}." },
    declined: { subject: "We couldn't confirm your request ({ref})", intro: "Unfortunately we couldn't confirm your requested time.", reason: "Reason: {reason}", rebook: "Choose another time" },
  },
  web: { /* filled in Task 12 */ },
} as const;
```

Processor algorithm: select ≤ limit jobs `status='queued' AND send_after<=now` or `status='sending' AND locked_until<now`; for each, claim with conditional UPDATE (`changes===1`), `renderJob`; `skip` → status `skipped`; send; success → `sent`, `sent_at`; failure → `attempts+1`, `last_error` (message truncated to 500 chars, never the URL), backoff minutes `[1,5,15,60,240]` → `queued` with `send_after`, or `failed` when attempts reach 6.

Dev routes (`/api/dev/mail`, GET, only when `MAIL_MODE==="dev"`, else 404): newest 50 rows of `dev_mailbox`.

- [ ] **Step 1: Failing tests** `test/worker/outbox.test.ts`:
1. `enqueueEmail` twice with same `dedupeKey` → one row.
2. `customer_login` job processed in dev mode → `dev_mailbox` row with subject "Your link to book remote support" and a `#t=` link; `auth_tokens` has 1 row; no raw token in `email_jobs.payload`.
3. Failure path: stub mailer by setting `MAIL_MODE` to `"cloudflare"` with `EMAIL` undefined → job `queued`, attempts 1, `send_after` +1 min; after 6 processing rounds with `setNow` advancing past each backoff → `failed`.
4. Precondition: `confirmed` template for a pending reservation → `skipped`.
5. Rendering escapes HTML in issue text (`<script>` appears as `&lt;script&gt;`).

(For test 3 add an optional `mailerOverride` parameter: `processOutbox(env, limit, mailer?)`.)

- [ ] **Step 2–4:** fail → implement → pass.
- [ ] **Step 5:** commit `feat(mail): durable outbox, dev mailbox, templates and i18n catalog`.

---

### Task 9: Scheduling context and customer availability API

**Files:** Create `src/worker/repos/schedule.ts`, `src/worker/scheduling/context.ts`, `src/worker/scheduling/availability.ts`, `src/worker/reservations/customer-routes.ts`; Test `test/worker/availability.test.ts`, `test/fixtures.ts`

**Interfaces — Produces:**
```ts
// test/fixtures.ts (used by all later worker tests)
export async function seedTeam(): Promise<{ admin: number; a: number; b: number; c: number; d: number }>; // 4 bookable staff (admin is also bookable) with example.test emails
export async function seedWeekly(weekday: number, startMin: number, endMin: number, staffIds: number[]): Promise<number>;
export async function seedCustomer(o?: { number?: string; name?: string; email?: string; active?: boolean; contactActive?: boolean }): Promise<number>;
export async function loginCustomer(email: string): Promise<string>;  // request → process outbox → redeem → returns cookie
export async function loginStaff(email: string): Promise<string>;
export const TZ = "Asia/Tokyo";
// scheduling/context.ts
export interface ScheduleCtx { settings: Settings; bh: BhCtx; cfg: SlotCfg; slots: Slot[]; holds: Hold[]; version: number; holdOwners: Map<string, HoldOwner> }
export interface HoldOwner { kind: "reservation" | "option"; id: string; status: string; staffId: number | null; ref: string | null }
export async function loadScheduleCtx(env: Env, fromMs: number, toMs: number): Promise<ScheduleCtx>;
//   slots for dates covering [fromMs − 1 day, toMs + 1 day]; holds = pending/confirmed reservations + options of open proposals overlapping that range
//   pending hold: fixed=null, eligible = findSlot(slots,start)?.staffIds ?? [provisional], preferred = provisional_staff_id
//   confirmed: fixed = assigned_staff_id; option: fixed = staff_id
// scheduling/availability.ts
export async function customerAvailability(env: Env, fromDate: string, toDate: string): Promise<{ timezone: string; days: Array<{ date: string; slots: Array<{ startAt: number; endAt: number; spots: number }> }> }>;
//   clamps to [minNoticeAt(now), today + bookingHorizonDays]; drops spots === 0 slots; includes days with zero slots (empty array)
```

Routes (all `requireCustomer`):
- `GET /api/customer/accounts` → `eligibleAccountsForEmail` + `lastPhone` (most recent reservation phone for that account+email).
- `GET /api/customer/availability?from=YYYY-MM-DD&to=YYYY-MM-DD` (max 31 days span).

- [ ] **Step 1: Failing tests** `test/worker/availability.test.ts` — `setNow` to Thu 2026-10-01 08:00 Tokyo; weekly Thursday+Friday windows 10:00–11:00 with staff a,b; customer logged in:
1. Thursday 10:00 slot hidden by 3-BH min notice from 08:00 (earliest = 12:00 Thu) → Thursday shows no slots; Friday 10:00 & 10:30 show `spots: 2`.
2. Unauthenticated → 401.
3. Staff session cookie alone → 401 on customer availability.
4. After inserting a pending reservation at Fri 10:00 directly (with blocks for staff a) → Fri 10:00 shows `spots: 1`; Fri 10:30 shows `spots: 1` too (10:00 hold with 10-min buffer occupies a until 10:40, overlapping 10:30) — assert exactly this.

- [ ] **Step 2–4:** fail → implement → pass.
- [ ] **Step 5:** commit `feat(scheduling): schedule context and customer availability`.

---

### Task 10: Submit reservation (atomic, idempotent)

**Files:** Create `src/worker/reservations/submit.ts`; Modify `src/worker/reservations/customer-routes.ts`; Test `test/worker/submit.test.ts`

**Interfaces — Produces:**
```ts
export interface SubmitInput { customerId: number; startAt: number; contactName: string; phone: string; issue: string; idempotencyKey: string }
export async function submitReservation(env: Env, email: string, input: SubmitInput): Promise<{ id: string; ref: string; status: "pending"; created: boolean }>;
// throws HttpError 403 not_eligible | 409 slot_unavailable | 409 limit_reached | 400 too_soon
```
Route: `POST /api/customer/reservations` (Zod: contactName 1–100, phone 5–30 chars `[0-9+()\- ]`, issue 1–1000, idempotencyKey uuid, startAt int) → 201 `{ reservation }` (200 when `created === false`). Rate-limit `submit:<sessionHash>` 10/hour. After commit: `kickOutbox`.

Algorithm inside `withRetry`:
1. Existing by `idempotency_key` → return it (`created:false`).
2. Eligibility: customer active **and** email is an active contact → else 403.
3. Active count for customer (`status IN ('pending','confirmed')`) ≥ `maxActivePerAccount` → 409 `limit_reached`.
4. `startAt ≥ minNoticeAt(now)` and ≤ horizon → else 400 `too_soon` / 409 `slot_unavailable`.
5. `ctx = loadScheduleCtx(startAt − 1d, startAt + 1d)`; `slot = findSlot(ctx.slots, startAt)` else 409.
6. New hold `{id:newId, ...occupiedRange, fixed:null, eligible: slot.staffIds, preferred:null}`; `solve(component(holds ∪ new))` → null → 409 `slot_unavailable`.
7. Batch: `scheduleVersionGuard(v)`; eligibility `assertSql` (customer+contact active); for every pending hold whose provisional changed: `DELETE FROM tech_blocks WHERE owner_kind='reservation' AND owner_id=?`, `UPDATE reservations SET provisional_staff_id=?, updated_at=? WHERE id=? AND status='pending'`, insert its new blocks; `INSERT reservations` (pending, deadlines via `approvalDeadlines`, `ref=newRef()`); insert blocks for the new reservation (`INSERT INTO tech_blocks VALUES (?,?,'reservation',?)` per block); `enqueueEmail request_received` (dedupe `received:<id>`); one `new_request` per notify staff (dedupe `new:<id>:<staffId>`); `audit` (`reservation.requested`); `bumpScheduleVersion`.
   D1 limits: batch statements are fine (≤ 100 blocks per reservation at 5-min grid).

- [ ] **Step 1: Failing tests** `test/worker/submit.test.ts`:
1. Happy path → 201 pending, `tech_blocks` rows = 8 for one staff, 1 `request_received` + 4 `new_request` jobs, availability for that slot drops by 1.
2. Idempotent retry (same key) → 200 same id; still one reservation.
3. **Last spot race**: slot with only staff a; two different customers submit concurrently via `Promise.all` → exactly one 201, the other 409 `slot_unavailable`.
4. **Distinct technicians**: slot with a,b; two customers submit concurrently → both 201 with different `provisional_staff_id`.
5. Limit: second active request for same account → 409 `limit_reached`.
6. Customer deactivated between availability and submit → 403.
7. Other customer's account id in body → 403.
8. Provisional move: pending P at 10:00 eligible [a,b] provisional a; then a new 10:00-only-a window? (seed a second date-specific window is overkill) — instead: P at 10:00 (eligible a,b, provisional a), then confirmed booking fixed to b at 10:00 inserted directly → new submit at 10:00 → 409 (no spots), and P still provisional a or b consistently (no orphan blocks: `SELECT count(*) FROM tech_blocks` equals 16).

- [ ] **Step 2–4:** fail → implement → pass.
- [ ] **Step 5:** commit `feat(reservations): atomic pending request with provisional technician`.

---

### Task 11: Staff request queue, detail, approve, decline

**Files:** Create `src/worker/reservations/queries.ts`, `approve.ts`, `decline.ts`, `staff-routes.ts`; Test `test/worker/approve.test.ts`

**Interfaces — Produces:**
```ts
export interface ReservationDTO { id: string; ref: string; status: ReservationStatus; version: number; startAt: number; endAt: number;
  customer: { id: number; number: string; name: string; active: boolean }; contactName: string; contactEmail: string; phone: string; issue: string;
  assignedStaff: { id: number; name: string } | null; provisionalStaffId: number | null; createdAt: number; expiresAt: number | null;
  closedAt: number | null; closedBy: string | null; closeReason: string | null; confirmedAt: number | null; confirmedBy: { id: number; name: string } | null }
export interface TechOption { id: number; name: string; assignable: boolean; reason: null | "not_scheduled" | "unavailable" | "busy" | "needed_for_other_request"; conflictRef?: string }
export async function getReservation(db: D1Database, id: string): Promise<ReservationDTO | null>;
export async function listReservations(db: D1Database, f: { status?: ReservationStatus[]; from?: number; to?: number; staffId?: number }): Promise<ReservationDTO[]>;
export async function techOptions(env: Env, r: ReservationDTO): Promise<TechOption[]>; // all active bookable staff
export async function approveReservation(env: Env, actor: StaffPrincipal, id: string, staffId: number, version: number): Promise<ReservationDTO>;
export async function declineReservation(env: Env, actor: StaffPrincipal, id: string, reason: string, version: number): Promise<ReservationDTO>;
// conflicts: HttpError(409, "stale", { current: ReservationDTO }) ; HttpError(409, "tech_unavailable", { options: TechOption[] })
```
Routes (`requireStaff()`): `GET /api/staff/reservations?status=pending,confirmed&from&to&staffId`, `GET /api/staff/reservations/:id` → `{ reservation, techOptions, audit: AuditRow[] }`, `POST /api/staff/reservations/:id/approve {staffId, version}`, `POST /api/staff/reservations/:id/decline {reason (1–500), version}`.

Approve algorithm (`withRetry`): load; if `status!=='pending' || version!==input` → 409 `stale` with current; recheck customer active (else 409 `customer_ineligible`); `ctx = loadScheduleCtx(...)`; target hold `fixed = staffId`; `solve(component)` null → 409 `tech_unavailable` with fresh `techOptions`; batch: version guard, `assertSql` reservation pending+version, delete+reinsert blocks for every changed hold (target now on `staffId`), `UPDATE reservations SET status='confirmed', assigned_staff_id=?, provisional_staff_id=NULL, confirmed_at=?, confirmed_by=?, version=version+1, updated_at=? WHERE id=? AND status='pending' AND version=?`, enqueue `confirmed` (dedupe `confirmed:<id>:v<newVersion>`), `assigned` per notify staff (dedupe `assigned:<id>:v<newVersion>:<staffId>`), audit `reservation.approved` `{assignedStaffId}`, bump version. `kickOutbox`.

Decline: pending+version guard; delete blocks; status `declined`, `closed_*` fields, `close_reason`; enqueue `declined`; audit; bump.

`techOptions` reasons: not in slot staff → `not_scheduled`; unavailable (inactive / unavailability overlap) → `unavailable`; overlapping fixed hold (confirmed/option) on that staff → `busy` + its `ref`; otherwise unsolvable → `needed_for_other_request`.

- [ ] **Step 1: Failing tests** `test/worker/approve.test.ts`:
1. Approve with self → confirmed, `assigned_staff_id` = self, blocks moved to self, emails: 1 `confirmed`, 4 `assigned`.
2. **Duplicate approval (parallel)**: two staff approve concurrently → exactly one 200; other 409 `stale` whose `current.confirmedBy.name` is the winner; exactly one `confirmed` email job.
3. **Retry with same version after success** → 409 `stale` (no new jobs).
4. Approve with a technician held by another pending's only option → 409 `tech_unavailable`; `techOptions` marks that tech `needed_for_other_request`.
5. Technician `busy` (confirmed elsewhere overlapping) shows reason `busy` with that ref.
6. Approve after customer deactivated → 409 `customer_ineligible`.
7. Decline → status declined, blocks removed, availability restored, `declined` email queued.
8. Customer cookie on `/api/staff/reservations` → 401.

- [ ] **Step 2–4:** fail → implement → pass.
- [ ] **Step 5:** commit `feat(reservations): staff approval with technician assignment and decline`.

---

### Task 12: Customer reservation views and access-token page API

**Files:** Modify `src/worker/reservations/customer-routes.ts`; Create `src/worker/reservations/access-routes.ts`; Test `test/worker/customer-views.test.ts`

**Interfaces — Produces:**
```ts
export interface CustomerReservationDTO { id: string; ref: string; status: ReservationStatus; startAt: number; endAt: number; accountName: string; contactName: string; phone: string; issue: string; createdAt: number; closeReason: string | null }
```
Routes:
- `GET /api/customer/reservations` (requireCustomer) → reservations whose `customer_id` ∈ `accountIdsForContact(email)` (includes inactive accounts), newest first.
- `GET /api/customer/reservations/:id` → 404 unless owned as above.
- `POST /api/access/reservation {token}` → resolve `access_tokens` by hash and `expires_at > now` → `{ reservation: CustomerReservationDTO, timezone, supportPhone, cancelCutoffMin }`; invalid → 404 `{error:"invalid_link"}`. Never reveals other reservations.

Tests: ownership (contact of account A cannot read B's reservation → 404); contact of the same account (second contact email) can see it; access token from a processed `request_received` email resolves; tampered token → 404; expired → 404.

- [ ] Steps: failing tests → implement → pass → commit `feat(reservations): customer reservation views and access links`.

---

### Task 13: Web app — shell, customer flow

**Files:** Create `src/web/api.ts`, `src/web/i18n.ts`, `src/web/format.ts`, `src/web/components/{Layout,Button,Card,StatusBadge,TimezoneNote,Field,Spinner,EmptyState}.tsx`, `src/web/pages/customer/{Start,Verify,Book,Success,MyReservations,ReservationAccess}.tsx`; Modify `src/web/App.tsx`, `src/web/main.tsx`, `src/shared/i18n/en.ts` (`web` section)

**Behaviour (spec §8, customer):**
- `api.ts`: `apiFetch<T>(path, { method, body })` sets `X-Requested-With: fetch`, `content-type: application/json`, `credentials: "same-origin"`; throws `ApiError { status, code, details }`.
- `/` **Start**: org name header; heading "Book a remote support session"; email field (type=email, autocomplete=email, inputMode=email) + Turnstile widget when `turnstileSiteKey` is set (load `https://challenges.cloudflare.com/turnstile/v0/api.js` lazily); submit → replace form with the neutral message and "Didn't get it? Check spam, or try again in a minute." + "Use a different email".
- `/auth/verify`: read `#t=` from `location.hash`, immediately `history.replaceState` to strip it; show big **Continue** button → `POST /api/auth/redeem`; success → navigate to `redirectPath || "/book"`; `410` → expired card with **Send me a new link** (`POST /api/auth/resend` with the same token) → neutral confirmation; `400/403` → "This link isn't valid" + link to `/`.
- `/book` (requires customer session; else redirect to `/` with `redirectPath`): steps in one page with a progress header (1 Time · 2 Details · 3 Review):
  - account picker if >1 accounts (radio cards with name + customer number);
  - date strip: horizontally scrollable buttons for each day from availability (weekday + date; disabled when no slots); fetch 14 days at a time, "Later dates" loads the next range;
  - slot list: large buttons "10:00 – 10:30" with sub-label "2 spots left" / "Last spot"; `TimezoneNote` above the list;
  - details: contact name (prefilled), callback phone (prefilled from `lastPhone` → contact phone → customer phone), issue (textarea, counter /1000);
  - review card with all facts + **Send request**; generate `idempotencyKey = crypto.randomUUID()` when entering review, reuse on retry;
  - `409 slot_unavailable` → banner "That time was just taken. Please pick another time." return to step 1 keeping details; `409 limit_reached` → banner linking to `/my`.
  - sticky bottom bar on mobile with the current selection and the primary button.
- `/book/success/:id`: amber status panel with the exact text from `en.email.requestReceived.intro`, ref, date/time + timezone, "What happens next" list, buttons **View my reservations** / **Done**.
- `/my`: list cards (status badge colours: pending amber, confirmed green, declined/expired/cancelled grey, completed slate), date/time + tz, ref; tapping opens detail panel.
- `/r`: reads `#t=`, strips hash, `POST /api/access/reservation`; shows status banner + details (cancel and proposal actions arrive in Plan 3; show nothing for them now).
- Logout link in header when signed in.
- Accessibility: labels for all inputs, focus-visible outlines, `aria-live="polite"` for async status messages, buttons ≥ 44px tall.

Verification (no unit tests for UI in this task): `npm run typecheck`; `npx vite build`; run `npm run dev` + `npm run seed` and walk through the flow manually at 375px width using the dev mailbox page from Task 14 (or curl `/api/dev/mail`). Commit `feat(web): customer booking flow`.

---

### Task 14: Web app — staff pages, dev mailbox, seed, E2E

**Files:** Create `src/web/pages/staff/{Login,Verify,Dashboard,ReservationDetail,StaffLayout}.tsx`, `src/web/pages/DevMail.tsx`, `scripts/seed-dev.mjs`, `playwright.config.ts`, `e2e/core-flow.spec.ts`

**Behaviour:**
- `/staff/login` + `/staff/auth/verify` mirror the customer pages using the staff endpoints; any `/staff/*` route without a staff session redirects to `/staff/login?next=<path+search>` and returns there after verify (`redirectPath`).
- `/staff` **Dashboard**: "Waiting for approval" list sorted by `expiresAt` with relative countdown ("expires in 3h 10m", red when < 1h), each row → detail; "Today" confirmed list with assigned technician; header nav (Dashboard · more links arrive in Plan 2) + sign out.
- `/staff/r/:id`: status banner; customer/account, contact, phone (tel: link), issue, time + tz, ref; **Approve** panel: tech list from `techOptions` as radio cards — assignable first; preselect current user when `?assign=me` and assignable, otherwise preselect nothing; non-assignable greyed with reason text ("Busy — R-XXXX-XXXX", "Not scheduled for this slot", "Needed for another pending request", "Unavailable"); **Confirm approval** → on 409 `stale` show "Already handled: {status} by {name} at {time}" and refresh; on `tech_unavailable` refresh options with a notice. **Decline** panel: reason textarea + confirm. `?action=approve|decline` opens that panel; `propose` shows "Coming soon" placeholder until Plan 3.
- `/dev/mail` (only when `/api/dev/mail` returns 200): list of messages (to, subject, time) with an iframe `srcdoc` preview; make links inside open in the same tab (`<base target="_top">` injected).
- `scripts/seed-dev.mjs`: writes `.wrangler/seed.sql` and runs `npx wrangler d1 execute DB --local --file .wrangler/seed.sql`. Data (synthetic): staff `admin@example.test` (Avery Admin, admin, bookable), `tech1..tech3@example.test` (Blake/Casey/Drew, technician); weekly windows Mon–Fri 09:00–12:00 [admin, tech1, tech2] and 13:00–17:00 [tech1, tech2, tech3]; customers from `docs/sample-customers.csv`. Idempotent (`INSERT OR IGNORE`).
- `playwright.config.ts`: `webServer: { command: "npm run dev -- --port 5173", url: "http://localhost:5173/api/health", reuseExistingServer: true }`, projects chromium desktop + Pixel 7.
- `e2e/core-flow.spec.ts`: seed; customer requests link for `frontdesk@example.test` → open `/dev/mail`, follow newest link → Continue → book first available slot → success page shows "not yet confirmed"; staff requests link for `tech1@example.test` → verify → open request → approve with self → customer `/my` shows Confirmed; dev mailbox has a "Confirmed:" subject. Use `setNow`-free real time (seed windows cover all weekdays; if run on a weekend, the test picks the first enabled date).

Verification: `npm run typecheck`, `npm test`, `npx playwright install chromium && npm run e2e` → PASS. Commit `feat(web): staff approval UI, dev mailbox, seed data and e2e`.

---

## Execution order

1 → 2 → 3 → 4 → 5 → 6 → **8 → 7** → 9 → 10 → 11 → 12 → 13 → 14.

## Next plans (written after this one ships)

- Plan 2: schedule editor + roster conflict resolution, unavailability, holidays, settings, staff management, customer admin + CSV import, calendar/filters, audit view, email failures UI.
- Plan 3: cancellation, reassign, rescheduling proposals, expiry/reminders/escalation cron, customer reminders, completion, `.ics`.
- Plan 4: deployment (Doppler, D1, custom domain, Email Service subdomain, Turnstile, CI deploy), `docs/SETUP.md`, verification report.
