import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, Navigate, NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { apiFetch, queryKeys, staffSignInPath, useMe, type Me } from "../../api";
import { AppMark, navLink, SignedInBanner, SignOutIcon, SkipLink, useRouteChange } from "../../components/Layout";
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

/** The staff area's own frame: organisation, "Scheduling" label, navigation, who is signed in, sign out. */
export default function StaffLayout() {
  const me = useMe();
  const signOut = useStaffSignOut();
  useRouteChange();
  const staff = me.data?.staff ?? null;

  return (
    <div className="flex min-h-dvh flex-col">
      <SkipLink />
      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/90 backdrop-blur dark:border-slate-800 dark:bg-slate-900/90">
        <div className="mx-auto flex min-h-16 w-full max-w-5xl items-center justify-between gap-2 px-4 sm:px-6">
          <Link to={staff ? "/staff" : "/staff/login"} className="flex min-h-11 min-w-0 items-center gap-2 rounded-lg font-semibold">
            <AppMark />
            {me.data ? <span className="truncate">{me.data.orgName}</span> : <Skeleton className="h-5 w-32" />}
            <span className="hidden shrink-0 rounded-md bg-slate-100 px-2 py-0.5 text-xs font-semibold tracking-wide text-slate-600 uppercase sm:inline dark:bg-slate-800 dark:text-slate-300">
              {t("web.staff.nav.area")}
            </span>
          </Link>
          {staff && (
            <nav aria-label={t("web.nav.main")} className="flex shrink-0 items-center gap-1">
              <NavLink to="/staff" end className={navLink}>
                {t("web.staff.nav.dashboard")}
              </NavLink>
              <span className="mx-1 hidden h-6 w-px bg-slate-200 sm:block dark:bg-slate-700" aria-hidden="true" />
              <span className="flex items-center gap-2 px-1 text-sm text-slate-700 dark:text-slate-300" title={staff.email}>
                <span
                  className="grid size-8 shrink-0 place-items-center rounded-full bg-blue-100 text-xs font-bold text-blue-800 dark:bg-blue-400/20 dark:text-blue-200"
                  aria-hidden="true"
                >
                  {initials(staff.name)}
                </span>
                <span className="sr-only md:not-sr-only md:max-w-40 md:truncate md:font-medium">{staff.name}</span>
              </span>
              <button
                type="button"
                className={`${navLink({ isActive: false })} min-w-11 justify-center`}
                onClick={() => signOut.mutate()}
                disabled={signOut.isPending}
              >
                <SignOutIcon />
                <span className="sr-only sm:not-sr-only">{t("web.nav.signOut")}</span>
              </button>
            </nav>
          )}
        </div>
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
