// Validation shared by the API and the schedule editor UI. Rules that need the database (staff exist and are
// active, ids exist) are checked by the server when the change is resolved.

import { z } from "zod";

const DAY_MS = 24 * 60 * 60_000;
export const MAX_UNAVAILABILITY_DAYS = 60;

const isCalendarDate = (s: string): boolean => {
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

export const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isCalendarDate, "invalid date");

const minuteOfDay = z.number().int().min(0).max(1440).refine((m) => m % 5 === 0, "must be on the 5-minute grid");
const idSchema = z.number().int().positive();

export const windowInputSchema = z
  .object({
    kind: z.enum(["weekly", "date"]),
    weekday: z.number().int().min(0).max(6).nullable(),
    date: isoDateSchema.nullable(),
    startMin: minuteOfDay,
    endMin: minuteOfDay,
    staffIds: z
      .array(idSchema)
      .min(1)
      .max(100)
      .refine((ids) => new Set(ids).size === ids.length, "duplicate staff"),
  })
  .refine((w) => w.endMin > w.startMin, { message: "end must be after start", path: ["endMin"] })
  .refine((w) => (w.kind === "weekly" ? w.weekday !== null && w.date === null : w.date !== null && w.weekday === null), {
    message: "weekly windows have a weekday, date windows a date (exactly one)",
    path: ["kind"],
  });

/** Individual window edits are for the weekly pattern; a date's windows are replaced together with override.set. */
const weeklyWindowSchema = windowInputSchema.refine((w) => w.kind === "weekly", {
  message: "date windows are set with override.set",
  path: ["kind"],
});

const noteSchema = z.string().trim().max(200);

export const windowChangeSchemas = [
  z.object({ type: z.literal("window.create"), window: weeklyWindowSchema }),
  z.object({ type: z.literal("window.update"), id: idSchema, window: weeklyWindowSchema }),
  z.object({ type: z.literal("window.delete"), id: idSchema }),
] as const;

export const overrideChangeSchemas = [
  z
    .object({
      type: z.literal("override.set"),
      date: isoDateSchema,
      windows: z.array(windowInputSchema).max(24),
      note: noteSchema.optional(),
    })
    .refine((c) => c.windows.every((w) => w.kind === "date" && w.date === c.date), {
      message: "every window must be a date window on the override's date",
      path: ["windows"],
    }),
  z.object({ type: z.literal("override.clear"), date: isoDateSchema }),
] as const;

export const unavailabilityChangeSchemas = [
  z
    .object({
      type: z.literal("unavailability.create"),
      staffId: idSchema,
      startAt: z.number().int().nonnegative(),
      endAt: z.number().int().nonnegative(),
      reason: noteSchema.optional(),
    })
    .refine((c) => c.endAt > c.startAt, { message: "end must be after start", path: ["endAt"] })
    .refine((c) => c.endAt - c.startAt <= MAX_UNAVAILABILITY_DAYS * DAY_MS, {
      message: `at most ${MAX_UNAVAILABILITY_DAYS} days`,
      path: ["endAt"],
    }),
  z.object({ type: z.literal("unavailability.delete"), id: idSchema }),
] as const;

/** The changes the schedule editor sends: weekly windows, date overrides, staff unavailability. */
export const scheduleEditSchema = z.discriminatedUnion("type", [
  ...windowChangeSchemas,
  ...overrideChangeSchemas,
  ...unavailabilityChangeSchemas,
]);
export type ScheduleEdit = z.output<typeof scheduleEditSchema>;

export const previewBodySchema = z.object({ change: scheduleEditSchema });
export const applyBodySchema = z.object({ change: scheduleEditSchema, version: z.number().int().nonnegative() });
