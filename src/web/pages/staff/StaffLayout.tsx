import { useEffect, useId, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, Navigate, NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { apiFetch, queryKeys, staffSignInPath, useMe, type Me } from "../../api";
import { AppMark, navLink, SignedInBanner, SkipLink, useRouteChange } from "../../components/Layout";
import { Skeleton } from "../../components/Spinner";
import { t } from "../../i18n";

/** Ends the staff session only; a customer session in the same browser is left alone. */
export function useStaffSignOut() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  return useMutation({
    mutationFn: () => apiFetch("/api/auth/logout", { method: "POST", body: { kind: "staff" } }),
    onSettled: () => {
      qc.removeQueries({ queryKey: ["staff"] });
      qc.setQueryData<Me>(queryKeys.me, (old) => (old ? { ...old, staff: null } : old));
      void qc.invalidateQueries({ queryKey: queryKeys.me });
      navigate("/staff/login", { replace: true });
    },
  });
}

/** Staff pages: without a staff session, go to staff sign-in and come back here afterwards. Never falls back to a customer session. */
export function RequireStaff() {
  const me = useMe();
  const location = useLocation();
  if (me.isPending) return <Skeleton className="h-96" />;
  if (!me.data?.staff) return <Navigate to={staffSignInPath(location.pathname + location.search)} replace />;
  return <Outlet />;
}

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");

interface NavItem {
  to: string;
  /** Catalog key under web.staff.nav. */
  label: string;
  end?: boolean;
  adminOnly?: boolean;
}

/**
 * Staff navigation, in display order: Dashboard · Calendar · Schedule · Customers · Team · Settings · Activity
 * (Team and Settings with `adminOnly`). Only pages that exist are listed; each page adds its entry when it lands.
 */
const NAV: NavItem[] = [
  { to: "/staff", label: "dashboard", end: true },
  { to: "/staff/schedule", label: "schedule" },
  { to: "/staff/team", label: "team", adminOnly: true },
  { to: "/staff/settings", label: "settings", adminOnly: true },
];

const tabLink = ({ isActive }: { isActive: boolean }) =>
  `inline-flex min-h-11 items-center border-b-2 px-3 text-sm font-medium ${
    isActive
      ? "border-blue-700 text-blue-700 dark:border-blue-400 dark:text-blue-300"
      : "border-transparent text-slate-600 hover:border-slate-300 hover:text-slate-900 dark:text-slate-400 dark:hover:border-slate-600 dark:hover:text-slate-100"
  }`;

const menuLink = ({ isActive }: { isActive: boolean }) =>
  `flex min-h-12 items-center rounded-lg px-3 font-medium ${
    isActive ? "bg-blue-50 text-blue-800 dark:bg-blue-400/10 dark:text-blue-200" : "text-slate-800 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800"
  }`;

function Avatar({ name }: { name: string }) {
  return (
    <span
      className="grid size-8 shrink-0 place-items-center rounded-full bg-blue-100 text-xs font-bold text-blue-800 dark:bg-blue-400/20 dark:text-blue-200"
      aria-hidden="true"
    >
      {initials(name)}
    </span>
  );
}

/** Phones: one "Menu" button opening the navigation, who is signed in, and sign out. */
function MobileMenu({ items, staff, onSignOut, signingOut }: { items: NavItem[]; staff: NonNullable<Me["staff"]>; onSignOut: () => void; signingOut: boolean }) {
  const [open, setOpen] = useState(false);
  const location = useLocation();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();

  // Following a link closes the menu.
  useEffect(() => setOpen(false), [location.key]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!panelRef.current?.contains(e.target as Node) && !buttonRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [open]);

  return (
    <div
      className="md:hidden"
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          setOpen(false);
          buttonRef.current?.focus();
        }
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((o) => !o)}
        className={`${navLink({ isActive: open })} gap-2`}
      >
        <svg className="size-5" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          {open ? (
            <path d="M6 6l12 12M18 6 6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          ) : (
            <path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          )}
        </svg>
        {t("web.staff.nav.menu")}
      </button>
      <div
        ref={panelRef}
        id={panelId}
        hidden={!open}
        className="absolute inset-x-0 top-full border-b border-slate-200 bg-white px-4 pt-2 pb-4 shadow-lg dark:border-slate-800 dark:bg-slate-900"
      >
        <nav aria-label={t("web.nav.main")}>
          <ul className="space-y-1">
            {items.map((item) => (
              <li key={item.to}>
                <NavLink to={item.to} end={item.end} className={menuLink}>
                  {t(`web.staff.nav.${item.label}`)}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
        <div className="mt-3 flex items-center gap-3 border-t border-slate-200 pt-3 dark:border-slate-800">
          <Avatar name={staff.name} />
          <div className="min-w-0 flex-1 text-sm">
            <p className="truncate font-medium">{staff.name}</p>
            <p className="truncate text-slate-600 dark:text-slate-400">{staff.email}</p>
          </div>
          <button type="button" className={`${navLink({ isActive: false })} gap-2`} onClick={onSignOut} disabled={signingOut}>
            <svg className="size-5" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {t("web.nav.signOut")}
          </button>
        </div>
      </div>
    </div>
  );
}

/** The staff area's own frame: organisation, "Scheduling" label, navigation, who is signed in, sign out. */
export default function StaffLayout() {
  const me = useMe();
  const signOut = useStaffSignOut();
  useRouteChange();
  const staff = me.data?.staff ?? null;
  const items = NAV.filter((item) => !item.adminOnly || staff?.role === "admin");

  return (
    <div className="flex min-h-dvh flex-col">
      <SkipLink />
      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/90 backdrop-blur dark:border-slate-800 dark:bg-slate-900/90">
        <div className="relative mx-auto flex min-h-16 w-full max-w-5xl items-center justify-between gap-2 px-4 sm:px-6">
          <Link to={staff ? "/staff" : "/staff/login"} className="flex min-h-11 min-w-0 items-center gap-2 rounded-lg font-semibold">
            <AppMark />
            {me.data ? <span className="truncate">{me.data.orgName}</span> : <Skeleton className="h-5 w-32" />}
            <span className="hidden shrink-0 rounded-md bg-slate-100 px-2 py-0.5 text-xs font-semibold tracking-wide text-slate-600 uppercase sm:inline dark:bg-slate-800 dark:text-slate-300">
              {t("web.staff.nav.area")}
            </span>
          </Link>
          {staff && (
            <>
              <MobileMenu items={items} staff={staff} onSignOut={() => signOut.mutate()} signingOut={signOut.isPending} />
              <div className="hidden shrink-0 items-center gap-1 md:flex">
                <span className="flex items-center gap-2 px-1 text-sm text-slate-700 dark:text-slate-300" title={staff.email}>
                  <Avatar name={staff.name} />
                  <span className="sr-only lg:not-sr-only lg:max-w-40 lg:truncate lg:font-medium">{staff.name}</span>
                </span>
                <button
                  type="button"
                  className={`${navLink({ isActive: false })} min-w-11 justify-center`}
                  onClick={() => signOut.mutate()}
                  disabled={signOut.isPending}
                >
                  {t("web.nav.signOut")}
                </button>
              </div>
            </>
          )}
        </div>
        {staff && (
          <nav aria-label={t("web.nav.main")} className="mx-auto hidden w-full max-w-5xl px-1 sm:px-3 md:block">
            <ul className="-mb-px flex gap-1">
              {items.map((item) => (
                <li key={item.to}>
                  <NavLink to={item.to} end={item.end} className={tabLink}>
                    {t(`web.staff.nav.${item.label}`)}
                  </NavLink>
                </li>
              ))}
            </ul>
          </nav>
        )}
      </header>
      <div aria-live="polite" className="mx-auto w-full max-w-5xl px-4 sm:px-6">
        <SignedInBanner email={staff?.email ?? null} onSignOut={() => signOut.mutate()} />
      </div>
      <main id="main" tabIndex={-1} className="mx-auto w-full max-w-5xl flex-1 px-4 pt-6 pb-16 outline-none sm:px-6 sm:pt-8">
        <Outlet />
      </main>
    </div>
  );
}
