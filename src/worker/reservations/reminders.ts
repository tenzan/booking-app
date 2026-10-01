import type { Settings } from "../../domain/settings";
import { MIN } from "../../domain/time";
import { enqueueEmail } from "../mail/outbox";

/** A reminder this close to now (or already past) is not worth sending: the confirmation just went out. */
const MIN_LEAD_MS = 5 * MIN;

/**
 * Statements queuing the customer's appointment reminders for a reservation that is being confirmed at `startAt`: one
 * per configured offset, due `offset` minutes before the start, skipping any already past or within five minutes of
 * `now`. Put them in the same batch as the confirming write. The dedupe key carries the start, so a reminder for
 * another start is never confused with this one; the payload's start lets the send-time check drop a stale reminder.
 */
export function reminderStatements(
  db: D1Database,
  settings: Pick<Settings, "customerReminderOffsetsMin">,
  reservation: { id: string; startAt: number; contactEmail: string },
  now: number,
): D1PreparedStatement[] {
  return settings.customerReminderOffsetsMin
    .map((offset) => ({ offset, sendAfter: reservation.startAt - offset * MIN }))
    .filter((r) => r.sendAfter >= now + MIN_LEAD_MS)
    .map((r) =>
      enqueueEmail(db, {
        template: "appointment_reminder",
        to: reservation.contactEmail,
        dedupeKey: `reminder:${reservation.id}:${reservation.startAt}:${r.offset}`,
        reservationId: reservation.id,
        payload: { startAt: reservation.startAt },
        sendAfter: r.sendAfter,
      }),
    );
}
