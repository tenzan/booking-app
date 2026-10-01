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
  moved: Array<{ id: string; ref: string; startAt: number; from: string | null; to: string }>;
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
