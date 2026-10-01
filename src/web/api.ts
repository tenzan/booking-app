import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { CodedMessage } from "../domain/csv";
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

export async function apiFetch<T>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: opts.method ?? "GET",
      credentials: "same-origin",
      headers: { "X-Requested-With": "fetch", "content-type": "application/json", accept: "application/json" },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
  } catch {
    throw new ApiError(0, "network");
  }
  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) {
    const code = typeof data?.error === "string" ? data.error : "http_error";
    throw new ApiError(res.status, code, data?.details, data ?? undefined);
  }
  return data as T;
}

export const isApiError = (e: unknown, status?: number, code?: string): e is ApiError =>
  e instanceof ApiError && (status === undefined || e.status === status) && (code === undefined || e.code === code);

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
  spots: number;
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

/** One row of a holiday CSV import as previewed. */
export interface HolidayImportRowView {
  line: number;
  date: string;
  name: string;
  status: "new" | "changed" | "unchanged" | "error";
  previousName?: string;
  error?: CodedMessage;
  /** Appointments or requests on this date the holiday would take away. */
  conflicts: number;
}

export interface HolidayImportPreview extends Previewed {
  rows: HolidayImportRowView[];
}

export interface TeamList {
  staff: StaffDTO[];
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
  /** Everything schedule-shaped; invalidate after any capacity change. */
  schedule: ["staff", "schedule"] as const,
  scheduleWindows: ["staff", "schedule", "windows"] as const,
  scheduleUnavailability: (query: string) => ["staff", "schedule", "unavailability", query] as const,
  holidays: (year: number) => ["staff", "schedule", "holidays", year] as const,
  settings: ["staff", "settings"] as const,
  team: ["staff", "team"] as const,
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
  const fromHash = new URLSearchParams(window.location.hash.slice(1)).get("t");
  if (fromHash) {
    window.history.replaceState({ ...state, fragmentToken: fromHash }, "", window.location.pathname + window.location.search);
    return fromHash;
  }
  return typeof state.fragmentToken === "string" ? state.fragmentToken : null;
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
