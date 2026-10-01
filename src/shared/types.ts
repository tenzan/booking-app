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
