import type { ConflictReason } from "../domain/roster";
import type { Settings } from "../domain/settings";

export type ReservationStatus = "pending" | "confirmed" | "declined" | "expired" | "cancelled" | "completed";

export interface ReservationDTO {
  id: string;
  ref: string;
  status: ReservationStatus;
  version: number;
  startAt: number;
  endAt: number;
  customer: { id: number; number: string; name: string; active: boolean };
  contactName: string;
  contactEmail: string;
  phone: string;
  issue: string;
  assignedStaff: { id: number; name: string } | null;
  provisionalStaffId: number | null;
  createdAt: number;
  expiresAt: number | null;
  closedAt: number | null;
  /** Display name for staff closures; the raw actor otherwise. */
  closedBy: string | null;
  closeReason: string | null;
  confirmedAt: number | null;
  confirmedBy: { id: number; name: string } | null;
}

/** What a customer may see of their own reservation: no staff, no provisional technician, no contact email. */
export interface CustomerReservationDTO {
  id: string;
  ref: string;
  status: ReservationStatus;
  startAt: number;
  endAt: number;
  accountName: string;
  customerNumber: string;
  contactName: string;
  phone: string;
  issue: string;
  createdAt: number;
  closeReason: string | null;
}

export type TechUnavailableReason = "not_scheduled" | "unavailable" | "busy" | "needed_for_other_request";

export interface TechOption {
  id: number;
  name: string;
  assignable: boolean;
  reason: null | TechUnavailableReason;
  /** Reference of the confirmed reservation / proposal option that makes the technician busy. */
  conflictRef?: string;
  /** The technician a confirmed appointment is assigned to now (reassigning to them is refused with same_tech). */
  current?: boolean;
}

export interface AuditRow {
  at: number;
  actorKind: "customer" | "staff" | "system";
  /** Staff display name for staff actors, otherwise the stored actor (customer email) or null. */
  actor: string | null;
  action: string;
  details: unknown;
}

/** An availability window as the schedule editor sends it (minutes since local midnight, 5-minute grid). */
export interface WindowInput {
  kind: "weekly" | "date";
  weekday: number | null;
  date: string | null;
  startMin: number;
  endMin: number;
  staffIds: number[];
}

/** A stored availability window. */
export interface WindowDTO extends WindowInput {
  id: number;
}

/** Settings fields a schedule change may patch. */
export type SettingsPatch = Partial<Settings>;

/** Every capacity-affecting edit; each is previewed (roster impact) before it is applied. */
export type ScheduleChange =
  | { type: "window.create"; window: WindowInput }
  | { type: "window.update"; id: number; window: WindowInput }
  | { type: "window.delete"; id: number }
  /** Replaces the date's windows; `windows: []` closes the date. */
  | { type: "override.set"; date: string; windows: WindowInput[]; note?: string }
  | { type: "override.clear"; date: string }
  | { type: "unavailability.create"; staffId: number; startAt: number; endAt: number; reason?: string }
  | { type: "unavailability.delete"; id: number }
  | { type: "holiday.set"; date: string; name: string }
  | { type: "holiday.delete"; date: string }
  /** Sets many holidays at once (CSV import); the combined impact is evaluated and applied as one change. */
  | { type: "holiday.bulk"; set: Array<{ date: string; name: string }> }
  | { type: "staff.update"; id: number; active?: boolean; bookable?: boolean }
  | { type: "settings.update"; patch: SettingsPatch };

export type { ConflictReason };

/** A hold that would lose its place (or, as a warning, had already lost it before the change). */
export interface ConflictDTO {
  /** Reservation id, or proposal option id for kind "option". */
  id: string;
  kind: "reservation" | "option";
  status: "pending" | "confirmed" | "option";
  /** The reservation the hold belongs to (same as `id` for reservations). */
  reservationId: string;
  ref: string;
  startAt: number;
  staffName: string | null;
  reason: ConflictReason;
  /** Technicians who could take this hold at the same time, and the pending requests that would then lose their place. */
  alternatives: Array<{ id: number; name: string; displaces: Array<{ id: string; ref: string }> }>;
  customerName: string;
}

/** What a schedule change would do to existing holds. Staff are shown by name. */
export interface ImpactDTO {
  /** Pending requests that move to another technician (applied together with the change). */
  moved: Array<{ id: string; ref: string; startAt: number; from: string | null; fromId: number | null; to: string; toId: number }>;
  /** Conflicts the change introduces; it cannot be applied while any remain. */
  conflicts: ConflictDTO[];
  /** Conflicts that already existed before the change and remain after it; they never block applying it. */
  warnings: ConflictDTO[];
}

export interface UnavailabilityDTO {
  id: number;
  staffId: number;
  staffName: string;
  startAt: number;
  endAt: number;
  reason: string | null;
}

export interface StaffDTO {
  id: number;
  email: string;
  name: string;
  role: "admin" | "technician";
  bookable: boolean;
  notify: boolean;
  active: boolean;
}

export interface CustomerListItemDTO {
  id: number;
  customerNumber: string;
  name: string;
  phone: string | null;
  active: boolean;
  contactsCount: number;
  activeContactsCount: number;
}

export interface CustomerListDTO {
  customers: CustomerListItemDTO[];
  /** Opaque; pass back as `cursor` for the next page. Null on the last page. */
  nextCursor: string | null;
}

export interface CustomerDTO {
  id: number;
  customerNumber: string;
  name: string;
  phone: string | null;
  notes: string | null;
  active: boolean;
}

export interface CustomerContactDTO {
  id: number;
  email: string;
  name: string | null;
  phone: string | null;
  active: boolean;
  /** The contact's email has booked for this customer: it can only be deactivated, never deleted. */
  hasHistory: boolean;
}

/** A reservation of the customer, as listed on the customer's page (newest start first). */
export interface CustomerReservationSummaryDTO {
  id: string;
  ref: string;
  status: ReservationStatus;
  startAt: number;
  endAt: number;
  contactName: string;
}

export interface CustomerDetailDTO {
  customer: CustomerDTO;
  contacts: CustomerContactDTO[];
  recentReservations: CustomerReservationSummaryDTO[];
}

export interface ReservationListDTO {
  reservations: ReservationDTO[];
  /** Opaque; pass back as `cursor` for the next page. Null on the last page. */
  nextCursor: string | null;
}

/** A reservation on the staff calendar. When the feed is filtered by technician, pending requests only provisionally on that technician are flagged. */
export interface CalendarReservationDTO extends ReservationDTO {
  provisionalForFilteredStaff?: boolean;
}

export interface CalendarSlotDTO {
  startAt: number;
  endAt: number;
  /** Technicians who can take a booking at this start. */
  staffIds: number[];
  /** Technicians holding a confirmed appointment or an open proposal option that overlaps the slot. */
  bookedStaffIds: number[];
  /** Pending requests whose hold overlaps the slot. */
  pendingCount: number;
}

export interface CalendarDTO {
  timezone: string;
  reservations: CalendarReservationDTO[];
  /** More reservations matched than the feed carries; narrow the range or filters. */
  truncated: boolean;
  slots: Array<{ date: string; slots: CalendarSlotDTO[] }>;
}

export interface AuditEntryDTO extends AuditRow {
  id: number;
  /** The stored actor, unresolved: the staff id (as text) for staff, the email for customers. */
  actorId: string | null;
  reservationId: string | null;
  reservationRef: string | null;
  customerId: number | null;
}

export interface AuditListDTO {
  entries: AuditEntryDTO[];
  nextCursor: string | null;
}

export type EmailStatus = "queued" | "sent" | "failed" | "skipped" | "cancelled";

export interface EmailJobDTO {
  id: string;
  template: string;
  /** Masked (`j***@example.test`) for technicians. */
  to: string;
  reservationId: string | null;
  ref: string | null;
  status: string;
  attempts: number;
  lastError: string | null;
  createdAt: number;
  sentAt: number | null;
  sendAfter: number;
}

export interface EmailListDTO {
  emails: EmailJobDTO[];
  nextCursor: string | null;
}

export interface EmailSummaryDTO {
  failed: number;
  queued: number;
}
