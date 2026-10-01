import { lazy, Suspense, type ReactNode } from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router";
import { signInPath, useMe } from "./api";
import { Layout } from "./components/Layout";
import { NotFound } from "./components/NotFound";
import { Skeleton } from "./components/Spinner";
import { t } from "./i18n";
import Book from "./pages/customer/Book";
import MyReservations from "./pages/customer/MyReservations";
import ReservationAccess from "./pages/customer/ReservationAccess";
import Start from "./pages/customer/Start";
import Success from "./pages/customer/Success";
import Verify from "./pages/customer/Verify";
import DevMail from "./pages/DevMail";
import Dashboard from "./pages/staff/Dashboard";
import StaffLogin from "./pages/staff/Login";
import ReservationDetail from "./pages/staff/ReservationDetail";
import StaffLayout, { RequireStaff } from "./pages/staff/StaffLayout";
import StaffVerify from "./pages/staff/Verify";

/** Staff-only and heavier (it carries the shared Zod validators): loaded on first visit, not with the customer pages. */
const SchedulePage = lazy(() => import("./pages/staff/schedule/SchedulePage"));
const SettingsPage = lazy(() => import("./pages/staff/settings/SettingsPage"));
const TeamPage = lazy(() => import("./pages/staff/team/TeamPage"));
const CustomersPage = lazy(() => import("./pages/staff/customers/CustomersPage"));
const CustomerDetail = lazy(() => import("./pages/staff/customers/CustomerDetail"));
const NewCustomerPage = lazy(() => import("./pages/staff/customers/CustomerEditor"));
const CustomerImport = lazy(() => import("./pages/staff/customers/ImportWizard"));

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
        <Route path="staff" element={<StaffLayout />}>
          <Route path="login" element={<StaffLogin />} />
          <Route path="auth/verify" element={<StaffVerify />} />
          <Route element={<RequireStaff />}>
            <Route index element={<Dashboard />} />
            <Route path="r/:id" element={<ReservationDetail />} />
            <Route path="schedule" element={<Suspense fallback={<Skeleton className="h-96" />}><SchedulePage /></Suspense>} />
            <Route path="customers" element={<Suspense fallback={<Skeleton className="h-96" />}><CustomersPage /></Suspense>} />
            <Route path="customers/new" element={<Suspense fallback={<Skeleton className="h-96" />}><NewCustomerPage /></Suspense>} />
            <Route path="customers/import" element={<Suspense fallback={<Skeleton className="h-96" />}><CustomerImport /></Suspense>} />
            <Route path="customers/:id" element={<Suspense fallback={<Skeleton className="h-96" />}><CustomerDetail /></Suspense>} />
            <Route path="team" element={<Suspense fallback={<Skeleton className="h-96" />}><TeamPage /></Suspense>} />
            <Route path="settings" element={<Suspense fallback={<Skeleton className="h-96" />}><SettingsPage /></Suspense>} />
            <Route path="*" element={<NotFound home="/staff" homeLabel={t("web.staff.nav.dashboard")} />} />
          </Route>
        </Route>
        <Route path="dev/mail" element={<DevMail />} />
      </Routes>
    </BrowserRouter>
  );
}
