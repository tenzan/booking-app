# Staff Calendar Subscriptions — Design Spec

Date: 2026-10-05 · Status: draft for review

Each staff member can subscribe once, in Google Calendar, Outlook or Apple Calendar, to the team's confirmed appointments. Later approvals, moves, reassignments and cancellations appear by themselves, with no per-appointment downloads. This lifts the original spec's "calendar subscriptions: out of scope" for **staff only**. Customers keep the per-appointment "Add to calendar" links.

---

## 1. What the user asked for, and what was decided

- Every staff member sees **the whole team's** appointments, not just their own, and their own stand out from the rest. *(user)*
- **Two subscriptions per person** *(user's choice of the recommended option)*:
  - **My appointments:** the appointments assigned to me.
  - **Team:** everyone else's appointments, each titled with the technician's first name.

  In every calendar app a subscription becomes its own calendar with its own colour and show/hide checkbox. That checkbox is the "only mine / whole team" toggle, so there is nothing to build for it. The two calendars never overlap, so there are no duplicates and one's own bookings keep their own colour.
- **Confirmed appointments only** *(user)*. Pending requests stay on the dashboard.
- **Assumption:** any active staff member may subscribe, technicians and admins alike, since staff can already see the whole team in the app.

---

## 2. User experience

**Where:** a "Subscribe in your calendar app" card on the staff **Calendar** page, under the filters, collapsed after the first visit. It holds:

| Row | Actions |
|---|---|
| **My appointments** | **Add to Google Calendar** · **Open in Apple Calendar / Outlook** · **Copy link** |
| **Team (everyone else)** | the same three |

- **Add to Google Calendar** opens `https://calendar.google.com/calendar/r?cid=<webcal URL>`, which brings up Google's "Add calendar" prompt.
- **Open in Apple Calendar / Outlook** is the `webcal://` link: macOS and iOS open Calendar's subscribe sheet, and Outlook desktop offers to subscribe.
- **Copy link** gives the `https://` address, for Outlook on the web ("Add calendar → Subscribe from web") and anything else.
- A short note under the card: "Google Calendar refreshes subscriptions on its own schedule, which can take several hours; Apple Calendar and Outlook usually update within an hour. The app and emails are always current. Once subscribed, you no longer need the per-appointment "Add to calendar" downloads."
- **Reset links**: a secondary action with a confirmation dialog: "Your current links stop working. Calendars subscribed with them stop updating; subscribe again with the new links." The links are never shown elsewhere, but they are not secret-proof once pasted into a calendar service, so a reset is the remedy if one leaks.

**In the subscribed calendar:**

| Calendar | Name (`X-WR-CALNAME`) | Event title | Event body |
|---|---|---|---|
| Mine | "{org} — my appointments" | `Pat Co (R-ZMWK-6J3X)` | as the staff `.ics`: contact, callback phone, issue, technician, link to the request page |
| Team | "{org} — team" | `Tim: Pat Co (R-ZMWK-6J3X)` (technician's first name) | the same |

- **What's included:** confirmed appointments from 30 days ago onward, with no upper limit (the booking horizon bounds it in practice). Cancelled, declined, expired and pending reservations are left out; when one stops being confirmed, it disappears at the next refresh.
- **Reassignment:** the event moves from one person's Team calendar to their Mine calendar (and back) at the next refresh. The UID stays the same.
- **UID:** `<ref>@<host>`, the same as the per-appointment `.ics` (both describe the same appointment). A staff member who earlier imported a single `.ics` into the same calendar sees it updated rather than duplicated. Imported into a different calendar, it shows twice; the card's note says the subscription replaces per-appointment downloads.

---

## 3. Design

### Data: migration 0008

```sql
CREATE TABLE calendar_feeds (
  staff_id INTEGER PRIMARY KEY REFERENCES staff(id),
  token TEXT NOT NULL UNIQUE,      -- 32 random bytes, base64url
  created_at INTEGER NOT NULL
);
```

- One row per staff member who has opened the card; created on first request.
- **The token is stored in plain text, unlike the app's other tokens. This is deliberate.** A subscription link has to be shown again (to subscribe on a second device, or after the browser forgets it). With a hashed token, getting the link again would mean resetting it, which silently breaks every calendar already subscribed.
  - The token only reads confirmed appointments, can be reset, and stops working when its owner is deactivated.
  - Anyone who can read the database can already read every appointment, so storing the token in plain text adds nothing for them.
  - The alternative, deriving links with an HMAC key, would need a new secret in every deployment's configuration, a burden for people self-hosting this open-source project.
- **Reset** replaces the token in place.
- `npm run seed -- --reset` deletes the table's rows.

### Endpoints

| Route | Who | What |
|---|---|---|
| `GET /api/staff/calendar-feed` | staff session | `{ mine, team }`: the `https://…` URLs, creating the token if missing |
| `POST /api/staff/calendar-feed/reset` | staff session | new token; returns the new URLs; audit log entry `calendar_feed.reset` |
| `GET /api/feed/<token>/mine.ics` · `/team.ics` | anyone with the link | the feed |

**Feed endpoint:**
- The token must belong to an **active** staff member; otherwise 404 with a short plain-text body, like the `/api/cal` links.
- Rate limited per IP (`feed:ip:`, 120 per 15 minutes, since calendar services poll).
- Response headers: `Content-Type: text/calendar; charset=utf-8` and `Cache-Control: no-store`. The `Content-Disposition` is inline, so the browser shows the feed rather than downloading a file.
- Calendar headers: `REFRESH-INTERVAL;VALUE=DURATION:PT1H` and `X-PUBLISHED-TTL:PT1H`.
- **Mine** = `status = 'confirmed' AND assigned_staff_id = me AND end_at > now − 30 days`. **Team** = the same with `assigned_staff_id <> me`.
- One query per feed. At most a few hundred events, each at most 75 bytes per line once folded.

### Code

- `src/domain/ics.ts`: `buildIcs` grows a multi-event form, `buildCalendar({ name, events })`, with the calendar name and the refresh properties. The single-event output stays byte-identical, so existing tests hold.
- `src/worker/reservations/ics.ts`: `staffEvent` is split, so one query can build many staff events from rows (no per-event lookups).
- `src/worker/calendar-feeds.ts` (new): token storage, reset, feed rows, and the feed routes.
- `src/web/pages/staff/calendar/SubscribeCard.tsx` (new): the card above, on the Calendar page.

### Security and privacy

- A feed carries customer contact details (the same as the staff `.ics`) to whichever calendar service the staff member chooses. The card says so in one line: "The links include customer contact details: keep them to yourself."
- **Deactivating** a staff member stops their feeds immediately, because the lookup requires `active = 1`.
- Feed URLs never appear in emails or logs from the app. The token sits in the URL path; Cloudflare request logs are the operator's own.

---

## 4. Out of scope

- Customer subscriptions (customers have one or two appointments; per-appointment links fit).
- Pending requests in feeds (decided: confirmed only).
- An admin switch to disable feeds for the whole team (deactivation and reset cover the risk; add it if an organisation's policy asks).
- Per-technician feeds other than one's own (e.g. "Tim's appointments"). The Team calendar plus the calendar app's search covers it.

---

## 5. Testing

- **Domain:** `buildCalendar` output (name, refresh properties, several events, folding), and the single-event output unchanged.
- **Worker:**
  - tokens: created once, stable on repeat requests, reset replaces them, the old token gets 404, and a deactivated staff member gets 404
  - Mine and Team are disjoint and together are all confirmed appointments in the window
  - reassignment moves an event between them
  - cancelled, pending and too-old appointments are excluded
  - titles: Team ones carry the technician's first name
  - rate limit; plain-text 404
  - the session endpoints require staff
- **End to end:** a staff member opens the card; the Google, `webcal://` and copy links are present; fetching the Mine URL returns their confirmed appointment; resetting gives new links and the old one stops.
