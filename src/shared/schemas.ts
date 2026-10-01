// Validation shared by the API and the schedule editor UI. Rules that need the database (staff exist and are
// active, ids exist) are checked by the server when the change is resolved.

import { z } from "zod";
import type { Settings } from "../domain/settings";

const DAY_MS = 24 * 60 * 60_000;
export const MAX_UNAVAILABILITY_DAYS = 366;

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

export const holidayNameSchema = z.string().trim().min(1).max(100);
export const MAX_HOLIDAY_IMPORT_ROWS = 400;

export const holidayChangeSchemas = [
  z.object({ type: z.literal("holiday.set"), date: isoDateSchema, name: holidayNameSchema }),
  z.object({ type: z.literal("holiday.delete"), date: isoDateSchema }),
] as const;

/** The changes the schedule editor sends: weekly windows, date overrides, staff unavailability, holidays. */
export const scheduleEditSchema = z.discriminatedUnion("type", [
  ...windowChangeSchemas,
  ...overrideChangeSchemas,
  ...unavailabilityChangeSchemas,
  ...holidayChangeSchemas,
]);
export type ScheduleEdit = z.output<typeof scheduleEditSchema>;

export const previewBodySchema = z.object({ change: scheduleEditSchema });
export const applyBodySchema = z.object({ change: scheduleEditSchema, version: z.number().int().nonnegative() });

// ---- Settings ---------------------------------------------------------------------------------------------------

const grid5 = (n: number) => n % 5 === 0;
const gridMessage = "must be a multiple of 5";
const intIn = (min: number, max: number) => z.number().int().min(min).max(max);
const gridIn = (min: number, max: number) => intIn(min, max).refine(grid5, gridMessage);

const businessDaySchema = z
  .object({ start: minuteOfDay, end: minuteOfDay })
  .refine((d) => d.start < d.end, { message: "end must be after start", path: ["end"] });

/** One validator per setting; the server also uses these to read stored values key by key. */
export const settingsShape = {
  orgName: z.string().trim().min(1).max(100),
  supportPhone: z.string().max(40).regex(/^[0-9+()\- .]*$/, "digits, spaces and + ( ) - . only"),
  remoteToolName: z.string().trim().min(1).max(60),
  customerInstructions: z.string().max(500),
  durationMin: gridIn(5, 480),
  bufferBeforeMin: gridIn(0, 120),
  bufferAfterMin: gridIn(0, 120),
  slotStepMin: gridIn(5, 1440),
  minNoticeBh: intIn(0, 72),
  bookingHorizonDays: intIn(1, 180),
  cancelCutoffMin: intIn(0, 2880),
  maxActivePerAccount: intIn(1, 10),
  businessHours: z.array(z.nullable(businessDaySchema)).length(7),
  approvalReminderBh: intIn(1, 200),
  approvalEscalationBh: intIn(1, 200),
  approvalExpiryBh: intIn(1, 200),
  expiryBeforeStartMin: intIn(0, 10080),
  proposalExpiryBh: intIn(1, 200),
  proposalExpiryBeforeStartMin: intIn(0, 10080),
  customerReminderOffsetsMin: z.array(intIn(5, 10080)).max(3),
  notifyCustomerOnReassign: z.boolean(),
  bookingEnabled: z.boolean(),
} satisfies { [K in keyof Settings]: z.ZodType<Settings[K]> };

/** Approval deadlines escalate in order: reminder, then escalation, then expiry. */
export const APPROVAL_ORDER_KEYS = ["approvalReminderBh", "approvalEscalationBh", "approvalExpiryBh"] as const;

const settingsObject = z.object(settingsShape);

/** A complete settings object (what the server holds after merging a patch). */
export const settingsSchema = settingsObject.superRefine((s, ctx) => {
  if (s.approvalReminderBh > s.approvalEscalationBh) {
    ctx.addIssue({ code: "custom", path: ["approvalReminderBh"], message: "must not exceed the escalation time" });
  }
  if (s.approvalEscalationBh > s.approvalExpiryBh) {
    ctx.addIssue({ code: "custom", path: ["approvalEscalationBh"], message: "must not exceed the expiry time" });
  }
});

/** Any subset of the settings; unknown keys are rejected. */
export const settingsPatchSchema = settingsObject
  .partial()
  .strict()
  .refine((p) => Object.values(p).some((v) => v !== undefined), "empty patch");

export const settingsPreviewBodySchema = z.object({ patch: settingsPatchSchema });
export const settingsApplyBodySchema = z.object({ patch: settingsPatchSchema, version: z.number().int().nonnegative() });

/**
 * Issues for `current` with `patch` applied: the patch's own fields, plus the cross-field approval ordering when the
 * patch touches one of those fields. Empty when the merged settings are valid.
 */
export function settingsPatchIssues(current: Settings, patch: Partial<Settings>): z.core.$ZodIssue[] {
  const touched = new Set(Object.keys(patch));
  const ordered = APPROVAL_ORDER_KEYS.some((k) => touched.has(k));
  const result = settingsSchema.safeParse({ ...current, ...patch });
  if (result.success) return [];
  return result.error.issues.filter((i) => {
    const key = String(i.path[0]);
    return touched.has(key) || (ordered && (APPROVAL_ORDER_KEYS as readonly string[]).includes(key));
  });
}
