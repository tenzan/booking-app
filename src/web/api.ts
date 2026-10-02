import { useEffect, useState } from "react";
import { useQuery, type QueryClient } from "@tanstack/react-query";
import type { CodedMessage } from "../domain/csv";
import type { ImportRow, ImportSummary } from "../domain/customer-import";
import type { HolidayImportRow } from "../domain/holiday-import";
import type { Settings } from "../domain/settings";
import type { AuditRow, CustomerReservationDTO, ImpactDTO, ReservationDTO, StaffDTO, TechOption, UnavailabilityDTO, WindowDTO } from "../shared/types";

/** A non-2xx API response (`status` 0 = the request never reached the server). */
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    public details?: unknown,
    public body?: Record<string, unknown>,
  ) {
    super(code);
  }
}

type ApiOpts = { method?: string; body?: unknown };

/** A successful response to an API request; any failure is thrown as an ApiError (JSON error bodies decoded). */
async function apiResponse(path: string, opts: ApiOpts, accept: string): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: opts.method ?? "GET",
      credentials: "same-origin",
      headers: { "X-Requested-With": "fetch", "content-type": "application/json", accept },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
  } catch {
    throw new ApiError(0, "network");
  }
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    const code = typeof data?.error === "string" ? data.error : "http_error";
    throw new ApiError(res.status, code, data?.details, data ?? undefined);
  }
  return res;
}

export async function apiFetch<T>(path: string, opts: ApiOpts = {}): Promise<T> {
  const res = await apiResponse(path, opts, "application/json");
  return (await res.json().catch(() => null)) as T;
}

/** An API request answered with a file (e.g. a calendar download), as a Blob. Errors as for apiFetch. */
export async function apiFetchBlob(path: string, opts: ApiOpts = {}): Promise<Blob> {
  return (await apiResponse(path, opts, "*/*")).blob();
}

export const isApiError = (e: unknown, status?: number, code?: string): e is ApiError =>
  e instanceof ApiError && (status === undefined || e.status === status) && (code === undefined || e.code === code);

/**
 * For apiFetch calls made outside React Query (whose global handler does this for queries and mutations): on a 401
 * re-ask "who am I", so the route guard sends the person to sign in. True when `e` was a 401.
 */
export function handleSignedOut(qc: QueryClient, e: unknown): boolean {
  if (!isApiError(e, 401)) return false;
  void qc.invalidateQueries({ queryKey: queryKeys.me });
  return true;
}

/** Same-origin absolute path, or null. Mirrors the server's check so a link can never send us off-site. */
export function safePath(p: string | null | undefined): string | null {
  return typeof p === "string" && p.startsWith("/") && !p.startsWith("//") && !p.includes("\\") && !/[\u0000-\u001f\u007f]/.test(p)
    ? p
    : null;
}

export interface Me {
  customer: { email: string } | null;
  staff: { id: number; email: string; name: string; role: string } | null;
  turnstileSiteKey: string | null;
  orgName: string;
  timezone: string;
  /** Admin switch: false while online booking is paused. */
  bookingEnabled: boolean;
  supportPhone: string;
}

export interface Account {
  id: number;
  customerNumber: string;
  name: string;
  contactName: string | null;
  contactPhone: string | null;
  customerPhone: string | null;
  lastPhone: string | null;
}

export interface Slot {
  startAt: number;
  endAt: number;
}

export interface Availability {
  timezone: string;
  days: Array<{ date: string; slots: Slot[] }>;
}

export interface SubmittedReservation {
  id: string;
  ref: string;
  status: string;
  startAt: number;
  endAt: number;
}

export interface AccessView {
  reservation: CustomerReservationDTO;
  timezone: string;
  supportPhone: string;
  cancelCutoffMin: number;
}

export interface StaffReservationView {
  reservation: ReservationDTO;
  techOptions: TechOption[];
  audit: AuditRow[];
}

/** A team member as the schedule editor lists them. */
export interface ScheduleStaff {
  id: number;
  name: string;
  bookable: boolean;
  active: boolean;
}

export interface ScheduleOverride {
  date: string;
  note: string | null;
  /** Empty: closed all day. */
  windows: WindowDTO[];
}

/** GET /api/staff/schedule/windows: the weekly pattern, date overrides from today on, and every team member. */
export interface ScheduleWindows {
  weekly: WindowDTO[];
  overrides: ScheduleOverride[];
  staff: ScheduleStaff[];
}

export interface UnavailabilityList {
  unavailability: UnavailabilityDTO[];
}

export interface Holiday {
  date: string;
  name: string;
}

/** What a capacity change would do, under the schedule version it was computed at (pass it back to apply). */
export interface Previewed {
  version: number;
  impact: ImpactDTO;
}

/** GET /api/staff/settings. */
export interface SettingsView {
  settings: Settings;
  timezone: string;
}

/** One row of a holiday CSV import as previewed, with the bookings on its date the holiday would take away. */
export type HolidayImportRowView = HolidayImportRow & { conflicts: number };

export interface HolidayImportPreview extends Previewed {
  rows: HolidayImportRowView[];
}

export interface TeamList {
  staff: StaffDTO[];
}

/** POST /api/staff/customers/import/preview: what the file would do; apply with the same text and `planHash`. */
export interface CustomerImportPreview {
  planHash: string;
  rows: ImportRow[];
  summary: ImportSummary;
  /** File-level notes that don't block the import (unknown columns). */
  warnings: CodedMessage[];
}

/** POST /api/staff/customers/import/apply. */
export interface CustomerImportResult {
  created: number;
  updated: number;
  unchanged: number;
  contactsAdded: number;
  contactsUpdated: number;
}

export interface DevMessage {
  id: number;
  to: string;
  subject: string;
  html: string;
  text: string;
  createdAt: number;
}

export const queryKeys = {
  me: ["me"] as const,
  accounts: ["customer", "accounts"] as const,
  availability: ["customer", "availability"] as const,
  reservations: ["customer", "reservations"] as const,
  reservation: (id: string) => ["customer", "reservations", id] as const,
  staffReservations: ["staff", "reservations"] as const,
  staffReservationList: (query: string) => ["staff", "reservations", "list", query] as const,
  staffReservation: (id: string) => ["staff", "reservations", "detail", id] as const,
  /** Under staffReservations, so any reservation change refreshes the calendar too. */
  calendar: (week: string, staffId: string, status: string) => ["staff", "reservations", "calendar", week, staffId, status] as const,
  audit: (action: string, actor: string) => ["staff", "audit", action, actor] as const,
  /** Every email-delivery query (lists and the summary); invalidate after a retry. */
  emails: ["staff", "emails"] as const,
  emailList: (status: string) => ["staff", "emails", "list", status] as const,
  emailSummary: ["staff", "emails", "summary"] as const,
  /** Everything schedule-shaped; invalidate after any capacity change. */
  schedule: ["staff", "schedule"] as const,
  scheduleWindows: ["staff", "schedule", "windows"] as const,
  scheduleUnavailability: (query: string) => ["staff", "schedule", "unavailability", query] as const,
  holidays: (year: number) => ["staff", "schedule", "holidays", year] as const,
  settings: ["staff", "settings"] as const,
  team: ["staff", "team"] as const,
  /** Every customer query (list pages and details); invalidate after any customer change. */
  customers: ["staff", "customers"] as const,
  customerList: (query: string, status: string) => ["staff", "customers", "list", query, status] as const,
  customer: (id: number) => ["staff", "customers", "detail", id] as const,
  devMail: ["dev", "mail"] as const,
};

export function useMe() {
  return useQuery({ queryKey: queryKeys.me, queryFn: () => apiFetch<Me>("/api/auth/me"), staleTime: 60_000 });
}

/**
 * Read `#t=<token>` from the URL and strip the fragment at once (keeps it out of history, screenshots and
 * shared links). The token is parked in this history entry's state so a reload — or a second StrictMode
 * render — still finds it. Idempotent.
 */
export function takeFragmentToken(): string | null {
  const state = (window.history.state ?? {}) as Record<string, unknown>;
  const hash = new URLSearchParams(window.location.hash.slice(1));
  const fromHash = hash.get("t");
  if (fromHash) {
    hash.delete("t");
    // The rest of the fragment (`action=cancel`, …) is parked with the token: see fragmentParams.
    const fragmentParams = Object.fromEntries(hash);
    window.history.replaceState({ ...state, fragmentToken: fromHash, fragmentParams }, "", window.location.pathname + window.location.search);
    return fromHash;
  }
  return typeof state.fragmentToken === "string" ? state.fragmentToken : null;
}

/** The other `#key=value` pairs that came with this history entry's fragment token (e.g. `action=cancel`). */
export function fragmentParams(): Record<string, string> {
  const p = (window.history.state as Record<string, unknown> | null)?.fragmentParams;
  return p && typeof p === "object" ? (p as Record<string, string>) : {};
}

/** Forget the parked fragment params once they have been acted on (a reload then opens the plain page). */
export function clearFragmentParams(): void {
  const state = (window.history.state ?? {}) as Record<string, unknown>;
  if (state.fragmentParams) window.history.replaceState({ ...state, fragmentParams: {} }, "", window.location.href);
}

/** The fragment token for this page; picks up a new one if another link is opened in the same tab. */
export function useFragmentToken(): string | null {
  const [token, setToken] = useState(takeFragmentToken);
  useEffect(() => {
    const onHash = () => {
      const next = takeFragmentToken();
      if (next) setToken(next);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  return token;
}

/** "/?next=<path>" — the start page sends the user back to `path` after signing in. */
export const signInPath = (next?: string): string => (next ? `/?next=${encodeURIComponent(next)}` : "/");
/** "/staff/login?next=<path>" — the staff sign-in page, returning to `path` after the link is redeemed. */
export const staffSignInPath = (next?: string): string => (next ? `/staff/login?next=${encodeURIComponent(next)}` : "/staff/login");
