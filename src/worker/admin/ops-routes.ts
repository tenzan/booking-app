import { Hono } from "hono";
import { z } from "zod";
import { occupiedRange } from "../../domain/slots";
import { MIN, utcToWall } from "../../domain/time";
import {
  auditListQuerySchema,
  calendarQuerySchema,
  CALENDAR_MAX_DAYS,
  EMAILS_PAGE_SIZE,
  emailListQuerySchema,
} from "../../shared/schemas";
import type {
  CalendarDTO,
  CalendarReservationDTO,
  CalendarSlotDTO,
  EmailJobDTO,
  EmailListDTO,
  EmailSummaryDTO,
} from "../../shared/types";
import type { AppEnv } from "../env";
import { decodeCursor, encodeCursor } from "../lib/cursor";
import { HttpError } from "../lib/http";
import { kickOutbox, retryFailedEmail, safeError } from "../mail/outbox";
import { requireStaff } from "../middleware/session";
import { listAudit, listReservations } from "../reservations/queries";
import { loadScheduleCtx } from "../scheduling/context";

/** Operations views for staff: calendar feed, audit log, email delivery failures. Technicians read; only admins retry emails. */
export const opsRoutes = new Hono<AppEnv>();

const CALENDAR_DEFAULT_STATUSES = ["pending", "confirmed"] as const;
/** Reservations a calendar feed carries at most (42 days of a small team's bookings fit comfortably). */
const CALENDAR_RESERVATION_CAP = 1000;

opsRoutes.get("/calendar", requireStaff(), async (c) => {
  const q = calendarQuerySchema.parse(c.req.query());
  if (q.to <= q.from) throw new HttpError(400, "invalid_range");
  if (q.to - q.from > CALENDAR_MAX_DAYS * 24 * 60 * MIN) throw new HttpError(400, "range_too_long");

  const [list, ctx] = await Promise.all([
    listReservations(c.env.DB, {
      status: q.status ?? [...CALENDAR_DEFAULT_STATUSES],
      from: q.from,
      to: q.to,
      limit: CALENDAR_RESERVATION_CAP,
      ...(q.staffId === undefined ? {} : { orProvisionalStaffId: q.staffId }),
    }),
    loadScheduleCtx(c.env, q.from, q.to),
  ]);

  // Provisional is internal: it only shows as a flag, and only on the technician's own view of the calendar.
  const reservations: CalendarReservationDTO[] = list.reservations.map((r) =>
    q.staffId === undefined ? r : { ...r, provisionalForFilteredStaff: r.assignedStaff?.id !== q.staffId },
  );

  // Hold ranges include buffers: a hold blocks a slot when it overlaps the slot's own occupied range.
  const pending = ctx.holds.filter((h) => ctx.holdOwners.get(h.id)?.status === "pending");
  const fixedHolds = ctx.holds.filter((h) => {
    const owner = ctx.holdOwners.get(h.id);
    return owner !== undefined && owner.status !== "pending" && owner.staffId !== null;
  });
  const days = new Map<string, CalendarSlotDTO[]>();
  for (const slot of ctx.slots) {
    if (slot.startAt < q.from || slot.startAt >= q.to) continue;
    const [occStart, occEnd] = occupiedRange(slot.startAt, slot.endAt, ctx.cfg);
    const overlaps = (h: { start: number; end: number }) => h.start < occEnd && occStart < h.end;
    const booked = new Set<number>();
    for (const h of fixedHolds) if (overlaps(h)) booked.add(ctx.holdOwners.get(h.id)!.staffId!);
    const date = utcToWall(slot.startAt, ctx.cfg.tz).date;
    const day = days.get(date) ?? [];
    day.push({
      startAt: slot.startAt,
      endAt: slot.endAt,
      staffIds: slot.staffIds,
      bookedStaffIds: [...booked].sort((a, b) => a - b),
      pendingCount: pending.filter(overlaps).length,
    });
    days.set(date, day);
  }

  const body: CalendarDTO = {
    timezone: c.env.APP_TIMEZONE,
    reservations,
    truncated: list.nextCursor !== null,
    slots: [...days.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([date, slots]) => ({ date, slots })),
  };
  return c.json(body);
});

opsRoutes.get("/audit", requireStaff(), async (c) => {
  return c.json(await listAudit(c.env.DB, auditListQuerySchema.parse(c.req.query())));
});

// ---- Email delivery -------------------------------------------------------------------------------------------------

/** `j***@example.test`: enough to recognise the address, not to harvest it. */
export function maskEmail(address: string): string {
  const at = address.lastIndexOf("@");
  if (at < 1) return "***";
  return `${[...address.slice(0, at)][0]}***${address.slice(at)}`;
}

interface EmailRow {
  id: string;
  template: string;
  to_email: string;
  reservation_id: string | null;
  ref: string | null;
  status: string;
  attempts: number;
  last_error: string | null;
  created_at: number;
  sent_at: number | null;
  send_after: number;
}

opsRoutes.get("/emails", requireStaff(), async (c) => {
  const q = emailListQuerySchema.parse(c.req.query());
  const full = c.var.staff!.role === "admin";
  const where = ["j.status = ?"];
  const binds: unknown[] = [q.status];
  if (q.cursor !== undefined) {
    const [createdAt, id] = decodeCursor(q.cursor, ["number", "string"]);
    where.push("(j.created_at < ? OR (j.created_at = ? AND j.id < ?))");
    binds.push(createdAt, createdAt, id);
  }
  const { results } = await c.env.DB
    .prepare(
      `SELECT j.id, j.template, j.to_email, j.reservation_id, r.ref, j.status, j.attempts, j.last_error, j.created_at, j.sent_at, j.send_after
       FROM email_jobs j LEFT JOIN reservations r ON r.id = j.reservation_id
       WHERE ${where.join(" AND ")} ORDER BY j.created_at DESC, j.id DESC LIMIT ?`,
    )
    .bind(...binds, EMAILS_PAGE_SIZE + 1)
    .all<EmailRow>();
  const page = results.slice(0, EMAILS_PAGE_SIZE);
  const last = page.at(-1);
  const emails: EmailJobDTO[] = page.map((j) => ({
    id: j.id,
    template: j.template,
    to: full ? j.to_email : maskEmail(j.to_email),
    reservationId: j.reservation_id,
    ref: j.ref,
    status: j.status,
    attempts: j.attempts,
    // Sanitized when stored; scrubbed again so that a token can never leave through this view.
    lastError: j.last_error === null ? null : safeError(j.last_error),
    createdAt: j.created_at,
    sentAt: j.sent_at,
    sendAfter: j.send_after,
  }));
  const body: EmailListDTO = { emails, nextCursor: results.length > EMAILS_PAGE_SIZE && last ? encodeCursor([last.created_at, last.id]) : null };
  return c.json(body);
});

opsRoutes.get("/emails/summary", requireStaff(), async (c) => {
  const row = await c.env.DB
    .prepare(
      `SELECT COALESCE(SUM(status = 'failed'), 0) AS failed, COALESCE(SUM(status = 'queued'), 0) AS queued
       FROM email_jobs WHERE status IN ('failed', 'queued')`,
    )
    .first<EmailSummaryDTO>();
  const body: EmailSummaryDTO = { failed: row?.failed ?? 0, queued: row?.queued ?? 0 };
  return c.json(body);
});

const emailIdParam = z.string().min(1).max(100);

opsRoutes.post("/emails/:id/retry", requireStaff("admin"), async (c) => {
  const id = emailIdParam.safeParse(c.req.param("id"));
  if (!id.success) throw new HttpError(404, "not_found");
  await retryFailedEmail(c.env.DB, id.data, c.var.staff!.id);
  kickOutbox(c);
  return c.json({ ok: true });
});
