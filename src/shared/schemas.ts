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

/** Most conflicts one change may answer in the same commit. */
export const MAX_RESOLUTIONS = 50;
/** Staged conflict answers sent with a schedule-affecting change; one per reservation. */
export const resolutionsSchema = z
  .array(z.object({ reservationId: z.string().min(1).max(64), staffId: z.number().int().positive() }))
  .max(MAX_RESOLUTIONS)
  .refine((rs) => new Set(rs.map((r) => r.reservationId)).size === rs.length, "one resolution per reservation");

export const previewBodySchema = z.object({ change: scheduleEditSchema, resolutions: resolutionsSchema.optional() });
export const applyBodySchema = z.object({ change: scheduleEditSchema, version: z.number().int().nonnegative(), resolutions: resolutionsSchema.optional() });

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

export const settingsPreviewBodySchema = z.object({ patch: settingsPatchSchema, resolutions: resolutionsSchema.optional() });
export const settingsApplyBodySchema = z.object({ patch: settingsPatchSchema, version: z.number().int().nonnegative(), resolutions: resolutionsSchema.optional() });

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

// ---- Staff ------------------------------------------------------------------------------------------------------

/** Longest email address accepted anywhere (RFC 5321 path limit). */
export const EMAIL_MAX = 254;
export const emailSchema = z.string().trim().max(EMAIL_MAX).pipe(z.email()).transform((e) => e.toLowerCase());
const staffNameSchema = z.string().trim().min(1).max(100);
export const staffRoleSchema = z.enum(["admin", "technician"]);

export const staffCreateSchema = z.object({
  email: emailSchema,
  name: staffNameSchema,
  role: staffRoleSchema,
  bookable: z.boolean(),
  notify: z.boolean(),
});

/** Non-capacity fields only. Unknown keys (email, active, bookable) are rejected: those have their own paths. */
export const staffPatchSchema = z
  .strictObject({ name: staffNameSchema.optional(), role: staffRoleSchema.optional(), notify: z.boolean().optional() })
  .refine((p) => Object.values(p).some((v) => v !== undefined), "empty patch");

const staffCapacityShape = { active: z.boolean().optional(), bookable: z.boolean().optional(), resolutions: resolutionsSchema.optional() };
const hasCapacityField = (b: { active?: boolean; bookable?: boolean }) => b.active !== undefined || b.bookable !== undefined;
export const staffPreviewBodySchema = z.object(staffCapacityShape).refine(hasCapacityField, "nothing to change");
export const staffApplyBodySchema = z.object({ ...staffCapacityShape, version: z.number().int().nonnegative() }).refine(hasCapacityField, "nothing to change");

// ---- Customers --------------------------------------------------------------------------------------------------

export const CUSTOMERS_PAGE_SIZE = 50;
/** Data rows (header excluded) one customer CSV import may carry. */
export const MAX_CUSTOMER_IMPORT_ROWS = 5000;
/** Characters of CSV text one customer import may carry ("1 MB"). */
export const MAX_CUSTOMER_IMPORT_CHARS = 1_000_000;
/** Request body limit for CSV imports (the JSON around the text included); every other request is capped lower. */
export const MAX_CSV_BODY_BYTES = 1024 * 1024;

/** Field bounds, shared with the forms (maxLength and the "too long" messages). */
export const CUSTOMER_NUMBER_MAX = 40;
export const CUSTOMER_NAME_MAX = 200;
export const PHONE_MAX = 40;
export const CUSTOMER_NOTES_MAX = 1000;
export const CONTACT_NAME_MAX = 100;
/** Contacts one create request may carry. */
export const MAX_CUSTOMER_CONTACTS = 50;
/** Longest customer search text. */
export const CUSTOMER_SEARCH_MAX = 200;
/** Reservations listed on a customer's page (newest first). */
export const CUSTOMER_RECENT_LIMIT = 10;

export const customerNumberSchema = z.string().trim().min(1).max(CUSTOMER_NUMBER_MAX).regex(/^[A-Za-z0-9._-]+$/, "letters, digits and . _ - only");
export const customerNameSchema = z.string().trim().min(1).max(CUSTOMER_NAME_MAX);
export const phoneSchema = z.string().trim().max(PHONE_MAX).regex(/^[0-9+()\- .]*$/, "digits, spaces and + ( ) - . only");
const customerNotesSchema = z.string().max(CUSTOMER_NOTES_MAX);
export const contactNameSchema = z.string().trim().max(CONTACT_NAME_MAX);

export const contactInputSchema = z.object({ email: emailSchema, name: contactNameSchema.optional(), phone: phoneSchema.optional() });

export const customerCreateSchema = z
  .object({
    customerNumber: customerNumberSchema,
    name: customerNameSchema,
    phone: phoneSchema.optional(),
    notes: customerNotesSchema.optional(),
    contacts: z.array(contactInputSchema).max(MAX_CUSTOMER_CONTACTS).default([]),
  })
  .refine((c) => new Set(c.contacts.map((x) => x.email)).size === c.contacts.length, { message: "duplicate contact email", path: ["contacts"] });

/** null (or an empty string) clears phone and notes. The number is immutable once the customer has reservations. */
export const customerPatchSchema = z
  .strictObject({
    customerNumber: customerNumberSchema.optional(),
    name: customerNameSchema.optional(),
    phone: phoneSchema.nullable().optional(),
    notes: customerNotesSchema.nullable().optional(),
  })
  .refine((p) => Object.values(p).some((v) => v !== undefined), "empty patch");

/** The email is the contact's identity: to change it, remove (or deactivate) the contact and add another. */
export const contactPatchSchema = z
  .strictObject({ name: contactNameSchema.nullable().optional(), phone: phoneSchema.nullable().optional(), active: z.boolean().optional() })
  .refine((p) => Object.values(p).some((v) => v !== undefined), "empty patch");

export const customerActiveSchema = z.object({ active: z.boolean() });

export const customerListQuerySchema = z.object({
  query: z.string().trim().max(CUSTOMER_SEARCH_MAX).default(""),
  status: z.enum(["active", "inactive", "all"]).default("active"),
  cursor: z.string().max(300).optional(),
});

// ---- Operations: reservation list, calendar, audit, email failures -------------------------------------------------

/** Query strings carry "" for a cleared field: treat it as absent. */
const blankToUndefined = (v: unknown) => (v === "" ? undefined : v);
const optionalInt = z.preprocess(blankToUndefined, z.coerce.number().int().optional());
/** A present, integer query value: "", missing and non-numeric all fail. */
const requiredInt = z.string().regex(/^-?\d+$/).transform(Number).pipe(z.number().int());
const optionalText = (max: number) => z.preprocess(blankToUndefined, z.string().max(max).optional());

export const RESERVATION_STATUSES = ["pending", "confirmed", "declined", "expired", "cancelled", "completed"] as const;
export const RESERVATIONS_PAGE_DEFAULT = 50;
export const RESERVATIONS_PAGE_MAX = 200;
export const CALENDAR_MAX_DAYS = 42;
export const AUDIT_PAGE_SIZE = 100;
export const EMAILS_PAGE_SIZE = 50;

/** Comma-separated statuses ("" = no filter). */
export const statusListSchema = z
  .preprocess(blankToUndefined, z.string().optional())
  .transform((s) => (s ? s.split(",") : undefined))
  .pipe(z.array(z.enum(RESERVATION_STATUSES)).optional());

export const reservationListQuerySchema = z.object({
  status: statusListSchema,
  from: optionalInt,
  to: optionalInt,
  staffId: optionalInt,
  limit: z.preprocess(blankToUndefined, z.coerce.number().int().min(1).max(RESERVATIONS_PAGE_MAX).default(RESERVATIONS_PAGE_DEFAULT)),
  cursor: optionalText(300),
});

export const calendarQuerySchema = z.object({
  from: requiredInt,
  to: requiredInt,
  staffId: optionalInt,
  status: statusListSchema,
});

export const AUDIT_ACTION_TERMS_MAX = 10;

/** Comma-separated action terms, each an exact action or a `prefix.`; blank terms are dropped, none left = no filter. */
const auditActionsSchema = z
  .preprocess(blankToUndefined, z.string().max(400).optional())
  .transform((s) => {
    const terms = (s ?? "").split(",").map((x) => x.trim()).filter((x) => x !== "");
    return terms.length > 0 ? terms : undefined;
  })
  .pipe(z.array(z.string().max(100).regex(/^[a-z_.]+$/)).max(AUDIT_ACTION_TERMS_MAX).optional());

export const auditListQuerySchema = z.object({
  reservationId: optionalText(100),
  customerId: optionalInt,
  actor: optionalText(254),
  action: auditActionsSchema,
  cursor: optionalText(300),
});

export const EMAIL_STATUSES = ["failed", "queued", "sent", "skipped", "cancelled"] as const;

export const emailListQuerySchema = z.object({
  status: z.preprocess(blankToUndefined, z.enum(EMAIL_STATUSES).default("failed")),
  cursor: optionalText(300),
});
