# Plan 4: Deployment Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the remaining production-readiness gaps (request-path robustness, mail send semantics, browser security headers, Turnstile UX, tooling, CI, operations docs, small lifecycle follow-ups) and verify the live deployment end to end.

**Architecture:** No new subsystems. Small, independent changes to the Worker (lib/turnstile, mail adapters, inbound handler, security headers, dev guard), the web sign-in form, three lifecycle follow-ups, the scripts/CI tooling, and docs, plus a post-deploy smoke script. Tasks 1–4 touch disjoint files and may run in parallel; Task 5 runs after they merge.

**Tech Stack:** Cloudflare Workers (Hono), D1, Workers Static Assets, React + Vite, Vitest 4 + @cloudflare/vitest-pool-workers, Playwright, Node 22 scripts with `node --test`, GitHub Actions, Doppler.

**Spec:** `docs/superpowers/specs/2026-10-01-remote-support-booking-design.md` (§5.6 security controls, §7.3 sending domain, §11 delivery step 4 "verification report").

## Global Constraints

- Public, generic repo: `example.com` / `example.test` only; no personal domains, emails or account IDs in git. Real values live in Doppler.
- Strings via `src/shared/i18n/en.ts`; displayed/emailed times carry a timezone label.
- Every capacity-changing write uses `capacityBatch` with in-batch asserts; stored occupied ranges only.
- Customer-facing data never includes technician names or ids. No GET mutates state. Tokens only in URL fragments.
- Responses keep `Referrer-Policy: no-referrer`, a strict CSP, `X-Content-Type-Options: nosniff`, `frame-ancestors 'none'` (spec §5.6).
- Never touch port 5180 (product owner's preview); never pkill vite/node. Worktree agents must not run `npm run e2e` (fixed port 5173, resets the local DB) — the controller runs e2e after merging.
- Commits end with the attribution lines from the implementer's system reminder.

---

### Task 1: Worker request-path and mail hardening

**Files:**
- Modify: `src/worker/lib/turnstile.ts`, `src/worker/mail/adapters.ts`, `src/worker/index.ts` (email handler), `src/worker/mail/inbound.ts` (only if needed for the wrapper), `src/worker/middleware/security.ts`, `public/_headers`, `src/worker/lib/local.ts`, `src/worker/dev/routes.ts`, `src/worker/repos/customers.ts`
- Test: `test/worker/turnstile.test.ts` (new or existing), `test/worker/mail-adapters.test.ts`, `test/worker/inbound*.test.ts`, `test/worker/security-headers.test.ts`, `test/worker/dev-*.test.ts`, customer repo tests

Requirements (TDD each: failing test → fix → green):
1. **Turnstile siteverify timeout.** `fetch` to siteverify uses `AbortSignal.timeout(5000)`. Any failure (timeout, network, non-2xx, bad JSON) returns `false` and logs one line `console.warn("turnstile verify failed", safeError(e))` — never the token or secret. Test with a stubbed fetch that never resolves (fake timers or a short injectable timeout) and one that rejects.
2. **Mail adapter: no duplicate sends.** In `adapters.ts`, the "retry without custom headers" fallback runs only when the error clearly indicates a header rejection (match the binding's error message/name for disallowed headers; keep the matcher in one small exported predicate with a unit test). Any other error is rethrown so the outbox's backoff handles it (the outbox already re-checks preconditions before sending). Tests: header-rejection error → second send without headers, exactly 2 calls; generic/timeout error → rethrown, exactly 1 call.
3. **Inbound `email()` handler is error-safe.** Wrap the handler body so any thrown error is logged once (`console.error("inbound mail failed", safeError(e))`) and swallowed, except deliberate `message.setReject(...)` paths which stay as they are. Test: a DB failure injected during handling does not throw out of the handler and logs.
4. **HSTS.** Add `Strict-Transport-Security: max-age=31536000; includeSubDomains` to Worker API responses (security middleware) and to `public/_headers` for static assets. Do NOT add `preload`. Test asserts the header on an API response.
5. **Dev routes also require a loopback request.** `devMailEnabled(env)` stays as the env guard; dev routes (`/api/dev/*`) additionally require the request URL hostname to be `localhost` or `127.0.0.1` (else the same 404 `{error:"not_found"}`). Tests: dev env + loopback host → 200; dev env + `https://booking.example.com` request URL → 404.
6. **Bound `lastPhonesForEmail`.** Query selects only what it needs with `ORDER BY created_at DESC LIMIT 20`, dedupe stays in JS, returns at most 5 phones (keep the current cap if one exists). Test with > 20 reservations returns the newest phones.

Gates: `npm run typecheck && npm test` pristine. Commit per requirement or logically grouped.

---

### Task 2: Turnstile widget UX on sign-in forms

**Files:**
- Modify: `src/web/components/EmailLinkForm.tsx` (and its Turnstile helper if separate), `src/shared/i18n/en.ts` (only new keys under the existing sign-in/turnstile block)

Requirements:
1. Extend the `window.turnstile` type with `reset(widgetId)`. After every submit attempt that consumed the token (success, 4xx incl. 429, network error), call `turnstile.reset(widgetId)` and clear the stored token, so a spent token is never resent; the submit button waits for a fresh token as it does initially.
2. If the Turnstile script has not loaded within 10 s (hang without `onerror`), show the existing `turnstileFailed` notice (with its retry path). Clear the timer on load/unmount.
3. Keep behaviour when Turnstile is not configured (no site key) unchanged.
4. Verify with headless Chromium on your own dev server (not 5173/5180; use `npm run dev -- --port 5178` with `APP_BASE_URL=http://localhost:5178` in a local `.env`, removed afterwards), using Cloudflare's public Turnstile test site keys (always-pass `1x00000000000000000000AA`, always-fail `2x00000000000000000000AB`) set via `.env` for the session only: (a) pass key → request link → request again → second request carries a new token; (b) blocked script (route abort) → notice appears within ~10 s; (c) CSP: no console CSP violations with the pass key (the `_headers` CSP applies under `vite preview`/wrangler, so check with `npx wrangler dev` or document if only checkable in production — Task 5 checks production).

Gates: typecheck, `npm test`, `npx vite build` without warnings.

---

### Task 3: Lifecycle follow-ups from Plan 3

**Files:**
- Modify: `src/worker/reservations/cancel.ts`, `src/worker/reservations/decline.ts`, `src/worker/mail/templates.ts`, `src/worker/reservations/queries.ts` (customer DTO), `src/shared/types.ts`, `src/web/pages/customer/Book.tsx` (ReplaceBanner), `src/shared/i18n/en.ts`
- Test: `test/worker/cancel*.test.ts`, `test/worker/decline*.test.ts`, `test/worker/customer-views.test.ts`, mail template tests

Requirements:
1. **N1.** When staff cancel a confirmed original whose start has passed, its pending change request is NOT cancelled with it (it stands as the customer's own request, consistent with approval treating it as a new appointment). Before the start, current behaviour (cancel both, one email) stays. Test both sides of the boundary with `setNow`.
2. **N2.** The `declined` customer email omits the "Book another time" call to action when the declined reservation has a pending change request (`replaced_by` pending); instead it says that their change request R-… is still being reviewed. Template test for both variants.
3. **N3.** Customer reservation DTO gains `replacesStartAt` / `replacesEndAt` (numbers or null; times only — no staff data) for the replaced reservation. `ReplaceBanner` shows the root original's current time (with tz label) again in the change-of-a-change case, without an extra list query. Test the DTO fields in `customer-views.test.ts`.

Gates: typecheck, `npm test`, `npx vite build`; headless check of the banner at 375px + desktop on your own port (5179) if you change UI.

---

### Task 4: Tooling, CI and operations docs

**Files:**
- Modify: `scripts/render-wrangler.mjs` (extract the parser), Create: `scripts/lib/dotenv.mjs`, `scripts/dotenv.test.mjs` (add new script tests to the `test:scripts` list in package.json)
- Modify: `.github/workflows/ci.yml`, `.github/workflows/deploy.yml`
- Create: `scripts/smoke.mjs`, test for its pure parts
- Modify: `docs/SETUP.md`, `README.md`, `package.json` (script `smoke`)

Requirements:
1. **`.env` parser** (`parseDotenv(text) → Record<string,string>`): supports `export KEY=v`, blank lines, full-line `#` comments, inline ` #` comments on unquoted values, single/double-quoted values (inline `#` kept inside quotes, `\n` escapes in double quotes), trims surrounding whitespace, keys `[A-Za-z_][A-Za-z0-9_]*`. `render-wrangler.mjs` uses it. `node --test` cases for each rule.
2. **CI:** `ci.yml` runs on `push` to `main` only plus `pull_request` (no double runs on PR branches). Set `GITLEAKS_ENABLE_COMMENTS: false` in the gitleaks step env.
3. **Post-deploy smoke (`scripts/smoke.mjs <baseUrl>`):** checks and prints a pass/fail table, exits non-zero on failure:
   - `GET /api/health` → 200 `{ok:true}`
   - `GET http://<host>/` → redirect to https (skip with a note if the base URL is not https)
   - `GET /` → 200 HTML with `Content-Security-Policy` containing `frame-ancestors 'none'`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, `Strict-Transport-Security`
   - `GET /api/health` has the API security headers
   - `POST /api/dev/cron` with valid Origin + `X-Requested-With: fetch` → 404 (dev routes unreachable)
   - `POST /api/auth/customer/request` without `X-Requested-With` → 403 (CSRF guard live)
   - `GET /api/auth/me` → 200; report its `bookingEnabled` value (informational)
   `deploy.yml` runs `node scripts/smoke.mjs "https://$APP_DOMAIN"` after deploy (APP_DOMAIN from Doppler via `doppler run`). Unit-test the header/assertion helpers without network.
4. **Docs (SETUP.md new section "Operations"):** logs (`wrangler tail`, Workers Observability in the dashboard), rollback (`wrangler deployments list` / `wrangler rollback`, noting D1 migrations are forward-only and must stay backward compatible for one release), D1 backups (Time Travel: `wrangler d1 time-travel info/restore` with the 30-day window), running the smoke script, what the cron does on first deploy (silent stale-closing). README status: Plans 1–4 done; link to Operations.

Gates: `npm run test:scripts`, `npm run typecheck`, `npm test`.

---

### Task 5: Production verification (controller)

After Tasks 1–4 are merged, reviewed and deployed:
- [ ] Run `node scripts/smoke.mjs https://<APP_DOMAIN>` against production; all pass.
- [ ] Real email delivery: request a staff sign-in link for the bootstrap admin and confirm the message arrives with SPF/DKIM/DMARC pass (read the received headers); do not redeem the link.
- [ ] Check the live CSP with Turnstile in a real browser (no CSP console errors on `/` and `/staff/login`).
- [ ] Record results in the plan's SDD workspace (local, not committed) and summarize to the product owner, including the dashboard-only step for inbound Email Routing.

## Execution order

Tasks 1, 2, 3, 4 in parallel (isolated worktrees; disjoint files except `en.ts` keys in 2 and 3, resolved at merge) → reviews → merge → full suite + e2e → final review → PR/merge/deploy → Task 5.
