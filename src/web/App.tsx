import type { ReactNode } from "react";
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
            <Route path="*" element={<NotFound home="/staff" homeLabel={t("web.staff.nav.dashboard")} />} />
          </Route>
        </Route>
        <Route path="dev/mail" element={<DevMail />} />
      </Routes>
    </BrowserRouter>
  );
}
