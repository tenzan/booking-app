import { lazy, Suspense, type ReactNode } from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router";
import { signInPath, useMe } from "./api";
import { Layout } from "./components/Layout";
import { NotFound } from "./components/NotFound";
import { RouteErrorBoundary } from "./components/RouteErrorBoundary";
import { Skeleton } from "./components/Spinner";
import { t } from "./i18n";
import Book from "./pages/customer/Book";
import MyReservations from "./pages/customer/MyReservations";
import ReservationAccess from "./pages/customer/ReservationAccess";
import Start from "./pages/customer/Start";
import Success from "./pages/customer/Success";
import Verify from "./pages/customer/Verify";

/**
 * The staff area (and the dev mailbox) load on first visit: customers, who mostly arrive from an email link, never
 * download them.
 */
const StaffLayout = lazy(() => import("./pages/staff/StaffLayout"));
const RequireStaff = lazy(() => import("./pages/staff/StaffLayout").then((m) => ({ default: m.RequireStaff })));
const StaffLogin = lazy(() => import("./pages/staff/Login"));
const StaffVerify = lazy(() => import("./pages/staff/Verify"));
const Dashboard = lazy(() => import("./pages/staff/Dashboard"));
const ReservationDetail = lazy(() => import("./pages/staff/ReservationDetail"));
const DevMail = lazy(() => import("./pages/DevMail"));

/** Staff-only and heavier (it carries the shared Zod validators): loaded on first visit, not with the customer pages. */
const SchedulePage = lazy(() => import("./pages/staff/schedule/SchedulePage"));
const SettingsPage = lazy(() => import("./pages/staff/settings/SettingsPage"));
const TeamPage = lazy(() => import("./pages/staff/team/TeamPage"));
const CustomersPage = lazy(() => import("./pages/staff/customers/CustomersPage"));
const CustomerDetail = lazy(() => import("./pages/staff/customers/CustomerDetail"));
const NewCustomerPage = lazy(() => import("./pages/staff/customers/CustomerEditor"));
const CustomerImport = lazy(() => import("./pages/staff/customers/ImportWizard"));
const CalendarPage = lazy(() => import("./pages/staff/Calendar"));
const ActivityPage = lazy(() => import("./pages/staff/Activity"));
const EmailsPage = lazy(() => import("./pages/staff/Emails"));

/** A lazily loaded page: a skeleton while it loads, a calm "couldn't be loaded" message if it can't. */
function Lazy({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  return (
    <RouteErrorBoundary resetKey={pathname}>
      <Suspense fallback={<Skeleton className="h-96" />}>{children}</Suspense>
    </RouteErrorBoundary>
  );
}

/** Customer-only pages: without a session, go to the start page and come back here after signing in. */
function RequireCustomer({ children }: { children: ReactNode }) {
  const me = useMe();
  const location = useLocation();
  if (me.isPending) return <Skeleton className="h-96" />;
  if (!me.data?.customer) return <Navigate to={signInPath(location.pathname + location.search)} replace />;
  return children;
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Start />} />
          <Route path="auth/verify" element={<Verify />} />
          <Route path="r" element={<ReservationAccess />} />
          <Route path="book" element={<RequireCustomer><Book /></RequireCustomer>} />
          <Route path="book/success/:id" element={<RequireCustomer><Success /></RequireCustomer>} />
          <Route path="my" element={<RequireCustomer><MyReservations /></RequireCustomer>} />
          <Route path="*" element={<NotFound />} />
        </Route>
        <Route path="staff" element={<Lazy><StaffLayout /></Lazy>}>
          <Route path="login" element={<Lazy><StaffLogin /></Lazy>} />
          <Route path="auth/verify" element={<Lazy><StaffVerify /></Lazy>} />
          <Route element={<Lazy><RequireStaff /></Lazy>}>
            <Route index element={<Lazy><Dashboard /></Lazy>} />
            <Route path="r/:id" element={<Lazy><ReservationDetail /></Lazy>} />
            <Route path="calendar" element={<Lazy><CalendarPage /></Lazy>} />
            <Route path="activity" element={<Lazy><ActivityPage /></Lazy>} />
            <Route path="emails" element={<Lazy><EmailsPage /></Lazy>} />
            <Route path="schedule" element={<Lazy><SchedulePage /></Lazy>} />
            <Route path="customers" element={<Lazy><CustomersPage /></Lazy>} />
            <Route path="customers/new" element={<Lazy><NewCustomerPage /></Lazy>} />
            <Route path="customers/import" element={<Lazy><CustomerImport /></Lazy>} />
            <Route path="customers/:id" element={<Lazy><CustomerDetail /></Lazy>} />
            <Route path="team" element={<Lazy><TeamPage /></Lazy>} />
            <Route path="settings" element={<Lazy><SettingsPage /></Lazy>} />
            <Route path="*" element={<NotFound home="/staff" homeLabel={t("web.staff.nav.dashboard")} />} />
          </Route>
        </Route>
        <Route path="dev/mail" element={<Lazy><DevMail /></Lazy>} />
      </Routes>
    </BrowserRouter>
  );
}
