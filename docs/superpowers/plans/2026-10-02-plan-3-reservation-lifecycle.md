# Plan 3 — Reservation Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the reservation lifecycle: customer self-cancellation, rescheduling proposals (staff propose → customer accepts / keeps / picks another time), automatic expiry, approval reminders and escalation, customer appointment reminders, completion, calendar (.ics) export, and relaying customer email replies to the team.

**Architecture:** All lifecycle writes reuse the Plan 1–2 primitives: `capacityBatch` with in-batch asserts, stored occupied ranges, `movePendingStatements`/`blockInsert`, the outbox with send-time preconditions, and `cancelReservation`. A single minute cron (`scheduled()`) runs bounded, idempotent sweeps. Proposal options are holds (already modelled in `proposal_options` with `occ_*` and `tech_blocks owner_kind='option'`).

**Tech Stack:** unchanged (Worker + Hono + Zod + D1; React; Vitest pool-workers; Playwright). New dependency only for inbound mail parsing: `postal-mime` (workers-compatible).

**Spec:** `docs/superpowers/specs/2026-10-01-remote-support-booking-design.md` (§6.2–6.5, §7, §8 calendar export, §10)

## Global Constraints

- Public, generic repo: example.com / example.test only. Strings via `src/shared/i18n/en.ts`; every displayed or emailed time carries a timezone label.
- Every capacity-changing write uses `capacityBatch` and asserts every touched reservation/proposal/option row in-batch. New capacity writers in this plan: customer cancel, propose, withdraw/supersede, accept option, keep original (reject), replacement approve (cancels the original), pending expiry, proposal expiry, completion.
- Stored occupied ranges only (never recompute a hold's range from current settings). Option holds store `occ_start/occ_end` computed under the settings at proposal time.
- Cron sweeps are bounded (≤ 50 rows per kind per run), idempotent (safe to run twice concurrently), and never send email directly — they enqueue jobs with dedupe keys.
- Customer-facing data never includes technician names or ids; customer cancel/accept work without eligibility (spec: removing eligibility must not prevent cancelling), but require ownership (active contact session) or a valid reservation access token.
- No GET mutates state. Tokens only in URL fragments; downloads that need a token use POST and a client-side Blob.
- Never touch port 5180 (product owner's preview). Commits end with the attribution lines from your system reminder.

## Carried follow-ups (fold into the named task)

- Task 1: the involved technician (assigned / from / to) always receives notices about THEIR appointment even with notify=0; outbox re-checks reservation status immediately before `mailer.send`; schedule/settings/team apply routes call `kickOutbox`; customer cancel route maps the core's staff DTO to the customer DTO.
- Task 2: expiry clears `provisional_staff_id`; token/session/rate-limit cleanup.
- Task 5: staged-resolution retry signature includes each staged hold's current staff+version (silent re-apply only if unchanged).
- Task 8: ImpactDialog gains "Withdraw proposal" for option conflicts and "Propose new time" for pending conflicts.

---

### Task 1: Customer cancellation (API) + notification follow-ups

**Files:** `src/worker/reservations/{customer-routes,access-routes,cancel}.ts`, `src/worker/mail/{outbox,templates}.ts`, `src/worker/admin/{schedule,settings,staff}-routes.ts`; tests `test/worker/customer-cancel.test.ts`, extend outbox/reassign tests.

- `POST /api/customer/reservations/:id/cancel {reason?, version}` (session; ownership via active contact) and `POST /api/access/reservation/cancel {token, reason?, version}` (access token scoped to that reservation). Both call `cancelReservation` with `{kind:"customer", email}` (token path: the reservation's contact email), map the result to `CustomerReservationDTO`, and return `409 past_cutoff {details:{cutoffMin, supportPhone}}` for confirmed reservations inside the cutoff, `409 stale {current: CustomerReservationDTO}` on version mismatch, idempotent 200 per Plan 2 rules.
- Re-add the "Cancel reservation" link to customer emails (`/r#t=<token>&action=cancel`) for pending/confirmed reservations.
- Follow-ups listed above. Tests: ownership (other account 404), inactive customer can still cancel, cutoff, token path, stale, team notified incl. assigned tech with notify=0, status re-check skips a `confirmed` job when the reservation was cancelled after claim.

### Task 2: Lifecycle sweeps — expiry, approval reminders/escalation, completion, cleanup

**Files:** `src/worker/cron/{index,expiry,approval-reminders,completion,cleanup}.ts`, `src/worker/index.ts`, templates `expired`, `approval_reminder`, `approval_escalation`; tests `test/worker/cron.test.ts`.

- `runSweeps(env, now)` called from `scheduled()` (then `processOutbox`). Each sweep selects ≤ 50 due rows and processes them one by one with `withRetry` + `capacityBatch`.
- Pending expiry: `status='pending' AND expires_at <= now` → `expired`, closed_by_kind 'system', blocks deleted, provisional cleared, open proposal withdrawn (option blocks deleted), enqueue `expired` (customer: "we couldn't confirm in time" + rebook link) and team notice; audit `reservation.expired`. A replacement request (`replaces_id`) expiring leaves the original untouched.
- Approval reminder at `approval_reminder_at` and escalation at `escalation_at` for still-pending reservations: enqueue `approval_reminder` to notify staff (dedupe `approval-reminder:<id>:<staffId>`) and `approval_escalation` to active admins (dedupe `approval-escalation:<id>:<staffId>`); mark via dedupe only (no extra columns). Content: ref, customer, time+tz, deadline, link.
- Completion: `status='confirmed' AND end_at <= now` → `completed`, blocks deleted (keeps the table small), no emails; audit `reservation.completed` (actor system).
- Cleanup (once per hour, by `now` minute == 0): delete auth/access tokens expired > 7 days, sessions expired/revoked > 7 days, rate_limits whose window ended > 1 day, email_jobs `sent|skipped|cancelled` older than 90 days (keep failed), dev_mailbox older than 7 days.
- Tests with `setNow`: each sweep, idempotency (run twice), concurrency with an approval racing expiry (version guard → exactly one outcome), bounded batch size.

### Task 3: Customer appointment reminders

**Files:** `src/worker/reservations/{approve,reassign}.ts` (and Task 5 accept), `src/worker/mail/templates.ts`, `src/worker/reservations/reminders.ts`; tests.

- On confirm (approve, accept option, replacement approval) enqueue one `appointment_reminder` per `settings.customerReminderOffsetsMin` with `send_after = start_at − offset`, payload `{startAt}`, dedupe `reminder:<id>:<startAt>:<offset>`; skip offsets already in the past (or within 5 minutes).
- Send-time precondition: reservation confirmed AND `start_at === payload.startAt` (moved appointments skip stale reminders). Cancel/expire mark queued reminders cancelled (Task 1 already cancels reminder templates).
- Content: "Reminder: remote support {when + tz}", technician will call {phone}, have computer + {remoteToolName} ready, view/cancel links, add-to-calendar link.
- Remove "coming soon" from the Reminders settings card (UI wording only; settings already editable).

### Task 4: Rescheduling proposals — staff API

**Files:** `src/worker/reservations/propose.ts`, `staff-routes.ts`, `queries.ts` (proposal in DTO), templates `proposal`; tests `test/worker/propose.test.ts`.

- `POST /api/staff/reservations/:id/propose {options:[{startAt, staffId}] (1–3, distinct), message? ≤ 500, version}` for pending or confirmed reservations. Each option: a valid slot start under current settings, the staff free (`freeStaffAt`) for the option's occupied range (computed now under current settings and STORED), and the whole set (existing holds + option holds fixed) solvable. Options must not equal the current time+tech. Creates `proposals` (status open, `expires_at = min(created + proposalExpiryBh BH, original.start − proposalExpiryBeforeStartMin, earliest option.start − 60 min)`) + `proposal_options` + option blocks in one capacityBatch; an existing open proposal is superseded in the same batch (status superseded, its option blocks deleted). Enqueue `proposal` to the customer (access-token link to `/r#t=…&action=proposal`) and a team notice; audit `reservation.proposed`.
- `POST /api/staff/reservations/:id/proposal/withdraw {proposalId}` → withdrawn, option blocks deleted, customer notified.
- `GET /api/staff/reservations/:id` includes `proposal: {id, status, message, expiresAt, options:[{id,startAt,endAt,staffId,staffName}]} | null`; the customer DTO gets a technician-free version.
- Staff API helper to list candidate option slots: `GET /api/staff/reservations/:id/proposal-candidates?from&to` → per-slot assignable staff (reuse availability + assignableFor with the reservation's own hold excluded).

### Task 5: Rescheduling — customer responses and replacement requests

**Files:** `src/worker/reservations/{respond,submit,approve,decline}.ts`, access/customer routes, templates `rescheduled`, `proposal_outcome`; sweeps `proposal-expiry`; tests `test/worker/respond.test.ts`.

- Accept: `POST /api/access/proposal/accept {token, proposalId, optionId}` and session equivalent. capacityBatch: assert proposal open + reservation version + option exists; delete original blocks; re-own the option's blocks to the reservation (`UPDATE tech_blocks SET owner_kind='reservation', owner_id=? WHERE owner_kind='option' AND owner_id=?`); delete other options' blocks; reservation start/end/occ from the option, status confirmed, assigned = option staff, provisional NULL, version+1; proposal accepted; enqueue `rescheduled` (customer, with updated .ics link) + team; reminders re-enqueued (Task 3); audit. Option no longer available can't happen (held) but a closed proposal → 409 `proposal_closed {current}`.
- Keep original: `POST …/proposal/reject` → rejected, option blocks deleted, staff notified.
- Choose another time: the customer is taken to `/book?replaces=<id>`; submit accepts `replacesId` (must be the caller's reservation, pending or confirmed, with no other active replacement) → new pending reservation with `replaces_id`, the open proposal → rejected (option blocks released) in the same batch; does NOT count against max-active-per-account. Approving the replacement cancels the original in the same batch (close_reason 'rescheduled', blocks deleted, reminders cancelled, customer gets ONE `rescheduled` email instead of separate confirmed + cancelled); declining/expiring the replacement leaves the original as-is and tells the customer their original stays.
- Proposal expiry sweep (Task 2 framework): open proposals with `expires_at <= now` → expired, option blocks deleted, `proposal_outcome` to customer + staff; original unchanged.
- Staged-resolution retry signature follow-up (Plan 2) belongs to Task 8 UI; server side unchanged.

### Task 6: Calendar export (.ics)

**Files:** `src/domain/ics.ts`, access/customer/staff routes; tests `test/domain/ics.test.ts`, `test/worker/ics.test.ts`.

- `buildIcs({uid, sequence, method:"PUBLISH", status: CONFIRMED|CANCELLED, startAt, endAt, summary, description, location?, url})` RFC 5545 (CRLF, line folding at 75 octets, escaping of `,;\` and newlines, DTSTAMP, UTC times). UID `<ref>@<APP_DOMAIN>`, SEQUENCE = version.
- Customer: `POST /api/access/reservation/ics {token}` and `GET`-free session variant `POST /api/customer/reservations/:id/ics` → `text/calendar` attachment; only for confirmed (CONFIRMED) or cancelled-after-confirmation (CANCELLED); pending → 409 `not_confirmed`. Staff: `GET /api/staff/reservations/:id/ics` (session cookie; read-only). Description includes ref, the call instructions and a link to the reservation page; customer summary never names the technician; staff summary includes customer name.
- UI copy (Task 9): "Adds a snapshot to your calendar — we'll email you if anything changes."

### Task 7: Inbound reply relay

**Files:** `src/worker/mail/inbound.ts`, `src/worker/index.ts` (`email()` export), template `reply_relay`; tests `test/worker/inbound.test.ts`; `package.json` (`postal-mime`).

- `email(message, env, ctx)`: accept mail addressed to `MAIL_FROM` (or any address at its domain); drop auto-replies/bounces (`Auto-Submitted` ≠ no, `Precedence: bulk|list|auto_reply`, `X-Autoreply`, null return path, mailer-daemon/postmaster senders) silently; size cap 1 MB (`setReject` above); parse with postal-mime; enqueue `reply_relay` to every active notify staff with `{from, subject, textExcerpt ≤ 4000 chars, receivedAt}` and Reply-To = original sender; attachments not forwarded (mention count). Detect a reservation ref (`R-XXXX-XXXX`) in subject/body and link the staff detail page. Rate-limit per sender (20/hour). Never auto-reply.
- Docs: SETUP gains "Receiving replies" (Email Routing on the app hostname → route all/`no-reply@` to the Worker; never the apex).

### Task 8: Staff UI — proposals, conflict actions, lifecycle states

**Files:** `src/web/pages/staff/detail/ProposePanel.tsx`, `ReservationDetail.tsx`, `Dashboard.tsx`, `Calendar.tsx`, `schedule/ImpactDialog.tsx`, settings Reminders/Rescheduling cards, `en.ts`.

- Propose panel: pick up to 3 slots (date strip + slot list from proposal-candidates, each with a technician choice preselected to the current tech when free), optional message, preview of what the customer will see, send; shows the open proposal with status/expiry and Withdraw.
- Detail page shows proposal status, replacement links (original ↔ replacement), expired/completed states, .ics download.
- Dashboard: "Waiting for customer" section for open proposals; expiring-soon highlights; calendar shows violet option holds.
- ImpactDialog: "Withdraw proposal" for option conflicts; "Propose new time" for pending/confirmed conflicts (opens the reservation with the propose panel); staged-resolution silent re-apply only when each staged hold's staff+version is unchanged.
- Reminders and Rescheduling settings cards: remove "coming soon".

### Task 9: Customer UI — cancel, proposals, replacement, calendar

**Files:** `src/web/pages/customer/{ReservationAccess,MyReservations,Book}.tsx`, new `customer/ProposalResponse.tsx`, `en.ts`.

- `/r` and `/my`: Cancel with a confirm step (optional reason), past-cutoff message with the support phone, stale handling; `#…&action=cancel` opens the confirm directly.
- Proposal response (`/r#t=…&action=proposal`): the alternatives as large buttons (time + tz), "Keep my original time", "Choose another time" (→ `/book?replaces=…` with the access-token session handoff: if no customer session, request a link with redirect back), expiry note; outcomes clearly worded.
- Book page in replacement mode: banner "Choosing a new time for R-XXXX (currently …)"; success copy explains the original stays until the new time is confirmed.
- Add-to-calendar button for confirmed reservations (POST → Blob download).

### Task 10: E2E, seed, docs

- E2E: customer cancels from the email link; staff proposes 2 options → customer accepts one → both see the new time; customer chooses another time → staff approves replacement → original cancelled with one rescheduled email; pending expiry via a test-only `POST /api/dev/cron?now=` route available only in MAIL_MODE=dev on localhost (reuse the localhost guard) to run sweeps at a given time; .ics download.
- README Status: Plans 1–3 done; SETUP: receiving replies, reminders, rescheduling notes.

## Execution order

1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10
