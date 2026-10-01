# Plan 2 — Scheduling, Administration and Staff Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let staff run the service with real data: edit the weekly schedule, date overrides, holidays and time off with an impact preview that never silently invalidates a reservation; reassign or cancel appointments; manage settings, staff and customers (including CSV import); and see the team calendar, audit history and email failures.

**Architecture:** A pure roster-impact engine (`src/domain/roster.ts`) evaluates any proposed schedule change against current holds and returns moved pending allocations, conflicts and per-conflict alternative technicians. Every schedule-affecting write is a two-step preview → apply (apply carries the preview's schedule version and is refused when stale or when conflicts remain). All capacity writes go through `capacityBatch`. Holds carry their own stored occupied range so settings changes never move existing appointments.

**Tech Stack:** unchanged from Plan 1 (Worker + Hono + Zod + D1; React + React Router + TanStack Query + Tailwind; Vitest pool-workers; Playwright).

**Spec:** `docs/superpowers/specs/2026-10-01-remote-support-booking-design.md` (§4.4, §5.5, §6.4, §8 staff pages, §9, §11.3)

## Global Constraints

- Public, generic repo: example.com / example.test only; no org data. All user-facing strings via `src/shared/i18n/en.ts`; every displayed time carries a timezone label.
- **Every capacity-changing write uses `capacityBatch(db, version, stmts)`** (guard first, bump last) and asserts every touched reservation/option row in-batch (status and, where relevant, staff). Capacity writers in this plan: availability windows, date overrides, holidays, staff unavailability, staff deactivate / bookable toggle, capacity settings, reassign, staff cancel.
- **Stored occupied ranges:** after Task 1, holds use `occ_start`/`occ_end` stored on the row (set at creation from the then-current buffers). Changing duration/buffers/step affects only new requests; existing appointments never move.
- **5-minute grid:** durations, buffers, step and window bounds are positive multiples of 5 (step ≥ 5, duration ≥ 5, buffers ≥ 0); window 0 ≤ start < end ≤ 1440. Validate in shared Zod schemas used by both API and UI.
- **Preview → apply:** schedule-affecting endpoints expose `POST …/preview` (no writes) returning `{ version, impact }` and `POST …` (apply) taking `{ …change, version }`; apply returns 409 `stale_preview` when `schedule_state.version` moved, 409 `conflicts` (with impact) when conflicts remain. Moved pending allocations are applied in the same batch.
- **Permissions (spec §5.5):** technicians may view everything, approve/assign/decline/reassign/cancel reservations, and manage their **own** unavailability; admins additionally manage windows/overrides/holidays/settings/staff/customers/CSV import and retry failed emails. Enforced server-side with `requireStaff("admin")` or explicit ownership checks; UI hides what the user cannot do.
- Every admin or staff mutation writes an `audit_log` row (actor_kind 'staff', actor = staff id string, action `<area>.<verb>`, details JSON without secrets).
- No GET mutates state; non-GET requires Origin + `X-Requested-With: fetch` (existing middleware).
- The preview server for the product owner runs on port 5180: never kill it; stop only processes you start, by PID. Tests/e2e use 5173.
- Commits end with the attribution lines from your system reminder (Co-Authored-By + Claude-Session).

## Carried follow-ups from Plan 1 (fold into the named task)

- Task 2: matching distinguishes `impossible` vs `budget_exhausted` (roster preview reports budget exhaustion as a conflict reason instead of silently failing).
- Task 6: `reassignments audited`; clear `provisional_staff_id` when a reservation closes (decline/cancel).
- Task 9: `listReservations` gets a `limit`/`cursor`; empty query params ignored; `staffId` filter matches `assigned_staff_id` only (provisional is internal).
- Task 4: settings shape validation in `getSettings` (fall back per key to defaults on invalid stored values).
- Task 5: unify the two `safeRedirect` copies into `src/worker/lib/redirect.ts`.

## File Structure (new or substantially changed)

```
migrations/0002_hold_ranges.sql              occ_start/occ_end on reservations & proposal_options (+ backfill), unavailability checks
src/shared/schemas.ts                        Zod schemas shared by API + UI (settings, window, override, unavailability, staff, customer, contact)
src/domain/roster.ts                         rosterImpact(): moved pendings, conflicts, alternatives
src/domain/matching.ts                       solveDetailed(): { assignment } | { reason: "impossible" | "budget_exhausted" }
src/domain/csv.ts                            RFC 4180 parser + customer import row validation
src/worker/scheduling/roster.ts              loadRosterState(), previewChange(), applyChange() — bridges DB ↔ domain
src/worker/admin/schedule-routes.ts          windows, overrides, unavailability (preview/apply)
src/worker/admin/settings-routes.ts          settings + holidays (preview/apply for capacity-affecting)
src/worker/admin/staff-routes.ts             staff CRUD, deactivate (preview/apply), last-admin rule, session revoke
src/worker/admin/customer-routes.ts          customers + contacts CRUD, search, CSV import preview/apply
src/worker/admin/ops-routes.ts               audit log listing, email jobs listing + retry, calendar feed
src/worker/reservations/reassign.ts          same-time reassign
src/worker/reservations/cancel.ts            cancelReservation(core, used by staff now and customers in Plan 3)
src/worker/mail/templates.ts                 + cancelled (customer & team), reassigned (team; customer optional)
src/web/pages/staff/schedule/*               weekly editor, overrides, unavailability, ImpactDialog
src/web/pages/staff/settings/*               settings form, holidays
src/web/pages/staff/team/*                   staff list/editor
src/web/pages/staff/customers/*              list/search, detail/editor, CSV import wizard
src/web/pages/staff/{Calendar,Audit,Emails}.tsx
src/web/pages/staff/detail/{ReassignPanel,CancelPanel}.tsx
```

---

### Task 1: Stored occupied ranges (migration 0002)

**Files:** Create `migrations/0002_hold_ranges.sql`; Modify `src/worker/repos/schedule.ts`, `src/worker/scheduling/context.ts`, `src/worker/reservations/{submit,approve,holds}.ts`; Test `test/worker/hold-ranges.test.ts`

**Interfaces — Produces:** reservations and proposal_options rows have `occ_start INTEGER NOT NULL`, `occ_end INTEGER NOT NULL` (epoch ms); `loadScheduleCtx` builds holds from them (not from current buffers); `blockMinutes`-equivalent for stored ranges: `rangeBlocks(occStart, occEnd): number[]` in `src/domain/slots.ts`.

- [ ] **Step 1: Migration.** SQLite can't add NOT NULL without default to existing rows: `ALTER TABLE reservations ADD COLUMN occ_start INTEGER NOT NULL DEFAULT 0; … occ_end …`; backfill `UPDATE reservations SET occ_start = start_at - (SELECT …buffer_before from settings or default 0)*60000 …` — simpler and exact: backfill from existing `tech_blocks` (`MIN(block_start)*60000`, `(MAX(block_start)+5)*60000` per owner) for rows that have blocks, else from `start_at`/`end_at` with current defaults (0 / 10 min). Same for proposal_options. Add `staff_unavailability` CHECK via table rebuild is unnecessary — validate in the API instead.
- [ ] **Step 2: Failing tests** `test/worker/hold-ranges.test.ts`:
  1. Submit stores `occ_start = start − bufferBefore`, `occ_end = end + bufferAfter` (with settings buffer_after 10).
  2. Change setting `bufferAfterMin` to 0 in DB → availability for the adjacent slot still treats the existing reservation as occupying until `end+10` (spots unchanged), while a NEW reservation stores `end+0`.
  3. Approve moves blocks using the stored range (blocks count unchanged after buffer change).
  4. `rangeBlocks` boundary: start at :02 floors to :00; range ending exactly on a 5-min boundary excludes that block.
- [ ] **Step 3: Implement** (submit/approve compute and store ranges once; holds use stored ranges; `blockInserts` takes `rangeBlocks(occStart, occEnd)`).
- [ ] **Step 4:** `npm run typecheck && npm test` green. **Step 5:** commit `feat(schedule): store occupied ranges on holds`.

---

### Task 2: Roster impact engine (domain)

**Files:** Modify `src/domain/matching.ts`; Create `src/domain/roster.ts`; Test `test/domain/roster.test.ts`, extend `test/domain/matching.test.ts`

**Interfaces — Produces:**
```ts
// matching.ts
export type SolveResult = { ok: true; assignment: Map<string, number> } | { ok: false; reason: "impossible" | "budget_exhausted" };
export function solveDetailed(holds: Hold[]): SolveResult;   // solve() becomes a thin wrapper
// roster.ts
export interface RosterHold { id: string; kind: "reservation" | "option"; status: "pending" | "confirmed" | "option";
  ref: string; slotStart: number; occStart: number; occEnd: number; staffId: number | null }
export interface RosterInput { holds: RosterHold[]; slots: Slot[] /* generated under the PROPOSED roster */ }
export type ConflictReason = "tech_removed" | "slot_removed" | "no_capacity" | "too_complex";
export interface RosterConflict { id: string; kind: RosterHold["kind"]; status: RosterHold["status"]; ref: string;
  slotStart: number; staffId: number | null; reason: ConflictReason; alternatives: number[] }
export interface RosterImpact { moved: Array<{ id: string; ref: string; from: number | null; to: number }>; conflicts: RosterConflict[];
  assignment: Map<string, number> }   // final staff for every non-conflicting hold
export function rosterImpact(input: RosterInput): RosterImpact;
```
Algorithm:
1. Fixed holds (confirmed, option): valid iff `findSlot(slots, slotStart)` exists (else `slot_removed`) and contains `staffId` (else `tech_removed`). Invalid fixed holds become conflicts with `alternatives` = staff `s` in the new slot's staff such that fixing the hold to `s` keeps the valid set solvable (empty when the slot is gone).
2. Pending holds: eligible = new slot staff (none if slot removed → conflict `slot_removed`, alternatives []). Add pendings one at a time in deterministic order (slotStart, id) to the valid fixed set + already-accepted pendings; if `solveDetailed` fails, the pending becomes a conflict (`no_capacity`, or `too_complex` on budget exhaustion) and is excluded.
3. `moved` = accepted pendings whose final staff ≠ current provisional.
- [ ] **Step 1: Failing tests** (`test/domain/roster.test.ts`): no-op change → no moved/conflicts; removing tech B from a window with a confirmed(B) → conflict `tech_removed` with alternatives [A] when A free, [] when A busy; removing the whole window → `slot_removed`; pending on B with A free → moved B→A; two pendings, one tech left → one moved/kept, the other `no_capacity`; option hold treated like confirmed; determinism (same input → same output order); `solveDetailed` returns `budget_exhausted` when the budget is forced tiny (export a test-only budget parameter `solveDetailed(holds, budget?)`).
- [ ] **Step 2–4:** fail → implement → pass. **Step 5:** commit `feat(domain): roster impact engine`.

---

### Task 3: Roster bridge and schedule API (windows, overrides, unavailability)

**Files:** Create `src/worker/scheduling/roster.ts`, `src/worker/admin/schedule-routes.ts`, `src/shared/schemas.ts` (window/override/unavailability parts); Modify `src/worker/app.ts`; Test `test/worker/schedule-admin.test.ts`

**Interfaces — Produces:**
```ts
// scheduling/roster.ts
export type ScheduleChange =
  | { type: "window.create"; window: WindowInput } | { type: "window.update"; id: number; window: WindowInput } | { type: "window.delete"; id: number }
  | { type: "override.set"; date: string; windows: WindowInput[] /* [] = closed */ } | { type: "override.clear"; date: string }
  | { type: "unavailability.create"; staffId: number; startAt: number; endAt: number; reason?: string } | { type: "unavailability.delete"; id: number }
  | { type: "holiday.set"; date: string; name: string } | { type: "holiday.delete"; date: string }
  | { type: "staff.update"; id: number; active?: boolean; bookable?: boolean }
  | { type: "settings.update"; patch: Partial<Settings> };
export interface WindowInput { kind: "weekly" | "date"; weekday: number | null; date: string | null; startMin: number; endMin: number; staffIds: number[] }
export interface ImpactDTO { moved: Array<{ id: string; ref: string; from: string | null; to: string }>;   // staff names
  conflicts: Array<{ id: string; kind: string; status: string; ref: string; startAt: number; staffName: string | null; reason: ConflictReason;
    alternatives: Array<{ id: number; name: string }>; customerName: string }> }
export async function previewChange(env: Env, change: ScheduleChange): Promise<{ version: number; impact: ImpactDTO }>;
export async function applyChange(env: Env, actor: StaffPrincipal, change: ScheduleChange, version: number): Promise<{ version: number; impact: ImpactDTO }>;
```
Task 3 implements the in-memory application of EVERY `ScheduleChange` variant (including holiday/staff/settings — they are small transforms of `SlotInput`/settings) so Tasks 4–5 only add routes and validation. `previewChange`: load current holds for `[now, now + max(bookingHorizonDays, furthest active hold) days]`, build the proposed `SlotInput` by applying the change in memory (no DB writes), generate slots, run `rosterImpact`. `applyChange`: recompute (never trust client impact); version mismatch → 409 `stale_preview`; conflicts → 409 `conflicts` {impact}; else one `capacityBatch` with the change's statements + moved pending re-blocks (assert each moved hold still pending with its old provisional) + audit `schedule.<type>`.

Routes (mounted at `/api/staff/schedule`; GET for any staff, writes admin-only except own unavailability):
- `GET /windows` → `{ weekly: WindowDTO[], overrides: Array<{date, note, windows}> , staff: [{id,name,bookable,active}] }`
- `GET /unavailability?staffId&from&to` → list
- `POST /preview` `{ change }` → `{ version, impact }`; `POST /apply` `{ change, version }` → `{ version, impact }`
  - technicians may preview/apply only `unavailability.*` for their own staffId (403 otherwise).
- [ ] **Step 1: Failing tests:** window create/update/delete happy paths; validation (non-5-min, end ≤ start, unknown staff) → 400; removing a tech with a confirmed appointment → preview shows conflict with alternatives; apply → 409 conflicts; after reassigning (direct DB update in test) → apply succeeds; pending moved B→A applied atomically (blocks moved); stale version → 409 stale_preview; technician can add own unavailability, cannot add for others (403) or edit windows (403); unavailability overlapping a confirmed appointment → conflict; audit rows written; concurrent apply vs submit → one retries (deterministic batch hook from test/fixtures.ts).
- [ ] **Step 2–4.** **Step 5:** commit `feat(admin): schedule editing with roster impact preview`.

---

### Task 4: Settings and holidays API

**Files:** Create `src/worker/admin/settings-routes.ts`; Modify `src/shared/schemas.ts` (settings), `src/worker/repos/settings.ts` (validated read), `src/worker/scheduling/roster.ts` (settings/holiday change types); Test `test/worker/settings-admin.test.ts`

- `GET /api/staff/settings` (any staff) → `{ settings, timezone }`; `POST /api/staff/settings/preview|apply` (admin) for `settings.update` (capacity fields go through the roster engine; non-capacity fields apply with an empty impact). Validation per Global Constraints plus: minNoticeBh 0–72, bookingHorizonDays 1–180, cancelCutoffMin 0–2880, maxActivePerAccount 1–10, business hours per weekday null or {start<end, 5-min grid}, reminder/escalation/expiry BH ordering (reminder ≤ escalation ≤ expiry), customerReminderOffsetsMin 0–3 values each 5–10080, strings ≤ 500 chars.
- `getSettings` validates each stored key with the schema; invalid stored values fall back to the default for that key (warn without value).
- Holidays: `GET /api/staff/holidays?year=` ; `holiday.set` / `holiday.delete` via the same preview/apply (holiday closes weekly windows → may conflict); `POST /api/staff/holidays/import` (admin) `{ csv }` with `date,name` rows → preview list then apply (each row as a change in ONE batch; conflicts reported per date).
- Tests: invalid values 400 with field paths; capacity change with no conflicts applies; changing `durationMin` doesn't change existing reservation ranges (Task 1); holiday on a date with a confirmed appointment → conflict; getSettings fallback for a corrupt row; technician 403 on writes.
- Commit `feat(admin): settings and holidays`.

---

### Task 5: Staff management API

**Files:** Create `src/worker/admin/staff-routes.ts`, `src/worker/lib/redirect.ts` (unify safeRedirect); Modify `src/worker/repos/staff.ts`, `src/worker/auth/routes.ts`, `src/worker/mail/templates.ts` (use shared redirect); Test `test/worker/staff-admin.test.ts`

- `GET /api/staff/team` (any staff) → staff list `{id,email,name,role,bookable,notify,active}`.
- Admin: `POST /api/staff/team` create `{email,name,role,bookable,notify}` (email unique, lowercased); `PATCH /api/staff/team/:id` for name/role/notify (non-capacity); `POST /api/staff/team/:id/preview|apply` for `staff.update` with active/bookable (roster engine).
- Rules: cannot demote or deactivate the last active admin (409 `last_admin`); deactivation revokes that staff member's sessions in the same batch; a staff member cannot deactivate themselves (409 `self`).
- Tests for each rule, conflicts when deactivating a tech with confirmed appointments, session revoked (their cookie → 401), audit.
- Commit `feat(admin): staff management`.

---

### Task 6: Reassign and staff cancellation

**Files:** Create `src/worker/reservations/reassign.ts`, `src/worker/reservations/cancel.ts`; Modify `src/worker/reservations/staff-routes.ts`, `decline.ts` (clear provisional), `src/worker/mail/templates.ts`, `src/worker/mail/outbox.ts` (TemplateName), `src/shared/i18n/en.ts`; Test `test/worker/reassign-cancel.test.ts`

- `POST /api/staff/reservations/:id/reassign {staffId, version}` (confirmed only, same time): target must be assignable (eligible on the current slot and solvable with this hold fixed to them) else 409 `tech_unavailable` {options}; batch via capacityBatch with in-batch asserts; status stays confirmed, version+1; enqueue `reassigned` to notify staff (excluding actor) and to the customer only when `notifyCustomerOnReassign`; audit `reservation.reassigned {from,to}`. `techOptions` for confirmed reservations now returns the reassign candidates (current tech marked `current`).
- `cancelReservation(env, actor: {kind:"staff", staff} | {kind:"customer", email}, id, {reason?, version})` — core used now by staff (reason required 1–500) and by customers in Plan 3: non-terminal only; deletes blocks; status cancelled, closed_* fields, provisional cleared; cancels unsent reminder jobs for the reservation (`UPDATE email_jobs SET status='cancelled' WHERE reservation_id=? AND status='queued' AND template IN (…reminders…)`); enqueues `cancelled` to the customer and the team; idempotent: cancelling an already-cancelled reservation returns it unchanged (200, no new jobs); racing approval/cancel handled by version guard (409 stale).
- Templates: `cancelled` (customer: who cancelled — "our team" for staff —, reason when staff-provided, rebook link; team: ref, customer, time, actor), `reassigned` (team: from → to; customer: "your appointment time is unchanged").
- Tests: reassign happy path + busy target + stale + customer notification toggle; cancel pending & confirmed; repeated cancel idempotent; cancel vs approve race (batch hook) → exactly one wins and the loser gets 409 stale; reminder jobs cancelled; provisional cleared on decline/cancel; customer emails contain timezone labels.
- Commit `feat(reservations): reassign and staff cancellation`.

---

### Task 7: Customer administration API

**Files:** Create `src/worker/admin/customer-routes.ts`; Modify `src/worker/repos/customers.ts`, `src/shared/schemas.ts`; Test `test/worker/customers-admin.test.ts`

- `GET /api/staff/customers?query=&status=active|inactive|all&cursor=` (any staff) → paginated (50) by customer_number; query matches number, name or contact email (case-insensitive, `LIKE` with escaped wildcards).
- `GET /api/staff/customers/:id` → customer + contacts + recent reservations (10).
- Admin: `POST /api/staff/customers` `{customerNumber, name, phone?, notes?, contacts:[{email,name?,phone?}]}`; `PATCH /api/staff/customers/:id` (number immutable after creation unless no reservations exist); `POST /api/staff/customers/:id/contacts`, `PATCH …/contacts/:contactId` (name, phone, active), `DELETE …/contacts/:contactId` only when the contact never booked (else 409 `has_history` → deactivate instead); `POST /api/staff/customers/:id/active {active}`.
- Rules: customer numbers unique (trimmed, case-sensitive, 1–40 chars `[A-Za-z0-9._-]`); a contact email may appear on several customers but only once per customer; never merge accounts.
- Tests incl. technician 403 on writes, search escaping (`%`, `_`), pagination cursor, deactivated customer can no longer request a link (existing auth), contact deactivation hides reservations in /my (Plan 1 ruling) but access links still work.
- Commit `feat(admin): customer administration`.

---

### Task 8: CSV import (customers)

**Files:** Create `src/domain/csv.ts`; Modify `src/worker/admin/customer-routes.ts`; Test `test/domain/csv.test.ts`, `test/worker/customer-import.test.ts`

- `parseCsv(text): string[][]` (RFC 4180: quotes, escaped quotes, CRLF/LF, BOM, trailing newline; 5000-row cap).
- `planImport(rows, existing)` → per-row `{ line, action: "create" | "update" | "unchanged" | "error", customerNumber, messages: string[] }` + summary counts. Columns per spec §8 (`customer_number,name,phone,contact_email,contact_name,active`), header required, unknown columns → warning; rows sharing a customer number merge contacts; `active` accepts true/false/1/0/yes/no; never deletes customers or contacts; conflicting names for one number within the file → error on later rows.
- Routes (admin): `POST /api/staff/customers/import/preview {csv}` → plan (no writes); `POST /api/staff/customers/import/apply {csv, planHash}` → re-plans server-side, requires the same hash (409 `stale_import` otherwise) and zero error rows, then applies in batches of ≤ 50 statements per D1 batch inside one logical import with an audit row `customers.import {created, updated, unchanged}`.
- Tests: parser edge cases; the sample `docs/sample-customers.csv` previews 4 create + 1 inactive etc.; re-import → all unchanged; error rows block apply; hash mismatch → 409.
- Commit `feat(admin): customer CSV import`.

---

### Task 9: Calendar feed, audit log, email failures

**Files:** Create `src/worker/admin/ops-routes.ts`; Modify `src/worker/reservations/queries.ts` (limit/cursor, filters), `src/worker/mail/outbox.ts` (retry helper); Test `test/worker/ops.test.ts`

- `GET /api/staff/calendar?from&to&staffId&status` (≤ 42 days) → `{ timezone, reservations: ReservationDTO[] (pending/confirmed incl. provisional flag), windows: per-day slot capacity summary [{date, slots:[{startAt,endAt,staffIds,booked}]}] }`.
- `GET /api/staff/audit?reservationId&actor&action&cursor` (any staff) → newest first, 100 per page, actor names resolved.
- `GET /api/staff/emails?status=failed|queued|sent|skipped&cursor` (any staff; recipients shown masked for technicians `j***@example.test`, full for admins); `POST /api/staff/emails/:id/retry` (admin): only `failed` → `queued`, attempts reset, `send_after = now`, audit `email.retry`; kickOutbox. Dashboard badge count: `GET /api/staff/emails/summary` → `{ failed: n }`.
- `listReservations` gains `limit` (≤ 200) + `cursor`; empty query params ignored; `staffId` filters `assigned_staff_id` only.
- Tests for each, incl. retry of non-failed → 409, technician 403 on retry, masking.
- Commit `feat(admin): calendar feed, audit log and email failures`.

---

### Task 10: Web — staff navigation and schedule editor

**Files:** Create `src/web/pages/staff/schedule/{SchedulePage,WeeklyEditor,OverridesEditor,UnavailabilityEditor,ImpactDialog}.tsx`; Modify `StaffLayout.tsx` (nav: Dashboard · Calendar · Schedule · Customers · Team · Settings · Activity — admin-only items hidden for technicians), `App.tsx`, `en.ts`

UX: weekly editor shows Mon–Sun columns (stacked list on mobile) with time-range rows and technician chips (toggle); add/edit/delete inline with 5-minute time pickers; overrides as a date list with "closed" or custom ranges; unavailability list per technician with date-time range picker (technicians see only their own add/edit). Every save calls preview first: no impact → applies immediately with a toast; impact → `ImpactDialog` lists moved requests ("R-XXXX moves from Blake to Casey") and conflicts with inline actions: **Reassign to {alt}** (calls Task 6 reassign then re-previews), **Open request**, and for pending conflicts **Decline**; the Save button stays disabled until conflicts are zero; 409 stale_preview → silently re-preview and show "Schedule changed meanwhile — review the updated impact". Accessible dialog (focus trap, Esc, labelled), all strings via catalog.
Verification: typecheck, build, unit suite, headless walkthrough at 375px and desktop (light/dark) including a conflict resolved via reassign. Commit `feat(web): schedule editor with impact preview`.

---

### Task 11: Web — settings, holidays, team

**Files:** Create `src/web/pages/staff/settings/{SettingsPage,HolidaysEditor}.tsx`, `src/web/pages/staff/team/{TeamPage,StaffEditor}.tsx`; Modify `App.tsx`, `en.ts`

Settings grouped into cards (Organisation text · Appointments: duration/buffers/step · Booking window: min notice/horizon/cutoff/max active · Business hours per weekday · Approval deadlines · Reminders); client validation from `src/shared/schemas.ts` with inline errors; capacity changes go through the ImpactDialog; a note explains "Changes apply to new requests; existing appointments keep their times." Holidays: year selector, list, add, CSV import with preview. Team: list with role/bookable/notify/active toggles, add staff, deactivate via ImpactDialog, last-admin and self rules surfaced as clear messages. Technicians see read-only views. Verification as Task 10. Commit `feat(web): settings, holidays and team management`.

---

### Task 12: Web — customers and CSV import

**Files:** Create `src/web/pages/staff/customers/{CustomersPage,CustomerDetail,CustomerEditor,ImportWizard}.tsx`; Modify `App.tsx`, `en.ts`

Searchable, paginated list (number, name, contacts count, status chip); detail with contacts (activate/deactivate, add, edit), recent reservations linking to the staff detail page, activate/deactivate customer; create form. Import wizard: upload/paste CSV → preview table (action badges create/update/unchanged/error, per-row messages, filters, summary) → Apply (disabled while errors) → result summary. Downloadable sample CSV (`docs/sample-customers.csv` served as a static asset under `/samples/customers.csv`). Technicians: read-only. Verification as Task 10. Commit `feat(web): customer administration and CSV import`.

---

### Task 13: Web — calendar, activity, email failures, reassign/cancel panels

**Files:** Create `src/web/pages/staff/{Calendar,Activity,Emails}.tsx`, `src/web/pages/staff/detail/{ReassignPanel,CancelPanel}.tsx`; Modify `ReservationDetail.tsx`, `Dashboard.tsx` (failed-email banner using the summary endpoint), `App.tsx`, `en.ts`

Calendar: week grid on ≥ md (days as columns, 07:00–20:00 rows, blocks positioned by time; amber pending (dashed border = provisional/unassigned), green confirmed, violet proposal hold), agenda list on mobile; filters (technician, status) and week navigation; capacity shading per slot ("2 of 3 booked"); clicking a block opens the request. Activity: filterable audit list. Emails: failed/queued/sent tabs, retry (admin) with confirmation. Detail page: Reassign panel (radio cards from techOptions, current tech marked) and Cancel panel (reason required, explains the customer will be emailed); same focus/live-region conventions as Plan 1. Verification as Task 10. Commit `feat(web): calendar, activity, emails, reassign and cancel`.

---

### Task 14: E2E, seed and docs

**Files:** Modify `scripts/seed-dev.mjs` (seed must NOT wipe windows on plain runs — only with `--reset`; stop duplicating CSV customers), `e2e/*`, `README.md`, `docs/SETUP.md`; Create `e2e/admin-flow.spec.ts`

E2E: admin signs in → removes a technician from a window that has a confirmed appointment → ImpactDialog shows the conflict → reassign to the alternative → save succeeds; admin imports a CSV (one new customer) → the new contact can request a link; staff cancels a confirmed appointment → customer sees Cancelled in /my and a cancellation email in the dev mailbox. README Status section updated (Plan 2 done); SETUP gains an "Initial data" section (bootstrap admin, add staff, import customers, set schedule). Verification: typecheck, build, `npm test`, `npm run test:scripts`, `npm run e2e`. Commit `test(e2e): admin flows; docs: initial data setup`.

## Execution order

1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11 → 12 → 13 → 14
