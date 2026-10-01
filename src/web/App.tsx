import type { ReactNode } from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router";
import { signInPath, useMe } from "./api";
import { ButtonLink } from "./components/Button";
import { EmptyState } from "./components/EmptyState";
import { Layout, usePageTitle } from "./components/Layout";
import { Skeleton } from "./components/Spinner";
import { t } from "./i18n";
import Book from "./pages/customer/Book";
import MyReservations from "./pages/customer/MyReservations";
import ReservationAccess from "./pages/customer/ReservationAccess";
import Start from "./pages/customer/Start";
import Success from "./pages/customer/Success";
import Verify from "./pages/customer/Verify";

/** Customer-only pages: without a session, go to the start page and come back here after signing in. */
function RequireCustomer({ children }: { children: ReactNode }) {
  const me = useMe();
  const location = useLocation();
  if (me.isPending) return <Skeleton className="h-96" />;
  if (!me.data?.customer) return <Navigate to={signInPath(location.pathname + location.search)} replace />;
  return children;
}

function NotFound() {
  usePageTitle(t("web.common.notFoundHeading"));
  return (
    <EmptyState
      title={t("web.common.notFoundHeading")}
      body={t("web.common.notFoundBody")}
      action={<ButtonLink to="/">{t("web.common.homeLink")}</ButtonLink>}
    />
  );
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
      </Routes>
    </BrowserRouter>
  );
}
