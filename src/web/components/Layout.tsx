import { useEffect, useRef, useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { apiFetch, queryKeys, useMe, type Me } from "../api";
import { t } from "../i18n";
import { Skeleton } from "./Spinner";

/** Set when the destination page should confirm who is signed in (after redeeming a link). */
export interface SignedInState {
  signedIn?: boolean;
}

let navigated = false;

export function useSignOut() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  return useMutation({
    mutationFn: () => apiFetch("/api/auth/logout", { method: "POST", body: { kind: "customer" } }),
    onSettled: () => {
      qc.removeQueries({ queryKey: ["customer"] });
      qc.setQueryData<Me>(queryKeys.me, (old) => (old ? { ...old, customer: null } : old));
      void qc.invalidateQueries({ queryKey: queryKeys.me });
      navigate("/", { replace: true });
    },
  });
}

/** Document title "<page> · <org>". */
export function usePageTitle(title: string) {
  const org = useMe().data?.orgName;
  useEffect(() => {
    document.title = org ? `${title} · ${org}` : title;
  }, [title, org]);
}

/** Page <h1>. After in-app navigation it takes focus so screen readers announce the new page. */
export function PageHeading({ children, className = "" }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (navigated) ref.current?.focus({ preventScroll: true });
  }, []);
  return (
    <h1 ref={ref} tabIndex={-1} className={`text-2xl font-bold tracking-tight outline-none sm:text-3xl ${className}`}>
      {children}
    </h1>
  );
}

export const navLink = ({ isActive }: { isActive: boolean }) =>
  `inline-flex min-h-11 items-center rounded-lg px-2 text-sm sm:px-3 font-medium hover:bg-slate-100 dark:hover:bg-slate-800 ${
    isActive ? "text-blue-700 dark:text-blue-300" : "text-slate-700 dark:text-slate-300"
  }`;

/**
 * Per-layout route bookkeeping: remembers that an in-app navigation happened (so the next page heading takes
 * focus) and scrolls to the top when the path changes.
 */
export function useRouteChange() {
  const location = useLocation();
  const firstKey = useRef(location.key);
  // Set during render so page headings (whose effects run before ours) already see it.
  if (location.key !== firstKey.current) navigated = true;
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [location.pathname]);
}

/**
 * "Signed in as …" confirmation shown once after redeeming a link (history state `signedIn`), with a way out
 * for the wrong person. Render it inside an `aria-live` region.
 */
export function SignedInBanner({ email, onSignOut }: { email: string | null; onSignOut: () => void }) {
  const location = useLocation();
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  const show = (location.state as SignedInState | null)?.signedIn === true && email && dismissedKey !== location.key;
  if (!show) return null;
  return (
    <div className="mt-4 flex items-center gap-3 rounded-xl border border-blue-200 bg-blue-50 py-2 pr-2 pl-4 text-sm text-blue-950 dark:border-blue-400/30 dark:bg-blue-400/10 dark:text-blue-100">
      <p className="min-w-0 flex-1">
        <span className="font-medium break-words">{t("web.nav.signedInAs", { email })}</span>{" "}
        <button type="button" onClick={onSignOut} className="inline-flex min-h-11 items-center underline underline-offset-2">
          {t("web.nav.notYou")}
        </button>
      </p>
      <button
        type="button"
        onClick={() => setDismissedKey(location.key)}
        className="grid size-11 shrink-0 place-items-center rounded-lg hover:bg-blue-100 dark:hover:bg-blue-400/20"
        aria-label={t("web.common.dismiss")}
      >
        <svg className="size-5" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M6 6l12 12M18 6 6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}

export function SkipLink() {
  return (
    <a
      href="#main"
      className="sr-only z-50 rounded-lg bg-blue-700 px-4 py-3 font-semibold text-white focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
    >
      {t("web.nav.skip")}
    </a>
  );
}

/** Rounded app mark next to the organisation name in both headers. */
export function AppMark() {
  return (
    <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-blue-700 max-[400px]:hidden text-white dark:bg-blue-600" aria-hidden="true">
      <svg className="size-5" viewBox="0 0 24 24" fill="none">
        <path d="M4 5h16v10H4zM9 19h6M12 15v4" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}

export const SignOutIcon = () => (
  <svg className="size-5 sm:hidden" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** The customer frame; renders `children` instead of the route outlet when given (e.g. a not-found page outside the customer routes). */
export function Layout({ children }: { children?: ReactNode }) {
  const me = useMe();
  const signOut = useSignOut();
  useRouteChange();
  const customer = me.data?.customer ?? null;

  return (
    <div className="flex min-h-dvh flex-col">
      <SkipLink />
      <header className="border-b border-slate-200 bg-white/90 backdrop-blur dark:border-slate-800 dark:bg-slate-900/90">
        <div className="mx-auto flex min-h-16 w-full max-w-[40rem] items-center justify-between gap-2 px-4 sm:px-6">
          <Link to="/" className="flex min-h-11 min-w-0 items-center gap-2 rounded-lg font-semibold">
            <AppMark />
            {me.data ? <span className="truncate">{me.data.orgName}</span> : <Skeleton className="h-5 w-32" />}
          </Link>
          {customer && (
            <nav aria-label={t("web.nav.main")} className="flex shrink-0 items-center">
              <NavLink to="/my" className={navLink}>
                {t("web.nav.myReservations")}
              </NavLink>
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
      <div aria-live="polite" className="mx-auto w-full max-w-[40rem] px-4 sm:px-6">
        <SignedInBanner email={customer?.email ?? null} onSignOut={() => signOut.mutate()} />
      </div>
      <main id="main" tabIndex={-1} className="mx-auto w-full max-w-[40rem] flex-1 px-4 pt-6 pb-16 outline-none sm:px-6 sm:pt-10">
        {children ?? <Outlet />}
      </main>
    </div>
  );
}
