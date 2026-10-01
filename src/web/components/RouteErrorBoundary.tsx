import { Component, type ReactNode } from "react";
import { isReloading } from "../chunkReload";
import { t } from "../i18n";
import { Button } from "./Button";
import { EmptyState } from "./EmptyState";
import { usePageTitle } from "./Layout";
import { Skeleton } from "./Spinner";

/**
 * Around lazily loaded pages: a page that cannot be loaded (typically its chunk is gone after a deploy) or that fails
 * while rendering shows a calm message with a Reload button instead of a blank screen. A new `resetKey` (the
 * location) clears the failure, so navigating elsewhere tries again.
 */
export class RouteErrorBoundary extends Component<{ resetKey: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidUpdate(prev: { resetKey: string }) {
    if (this.state.failed && prev.resetKey !== this.props.resetKey) this.setState({ failed: false });
  }

  render() {
    if (!this.state.failed) return this.props.children;
    // An automatic reload is already on its way (see chunkReload): nothing to explain.
    return isReloading() ? <Skeleton className="h-96" /> : <PageLoadFailed />;
  }
}

function PageLoadFailed() {
  usePageTitle(t("web.common.pageLoadHeading"));
  return (
    <div role="alert">
      <EmptyState
        title={t("web.common.pageLoadHeading")}
        body={t("web.common.pageLoadBody")}
        action={<Button onClick={() => window.location.reload()}>{t("web.common.reload")}</Button>}
      />
    </div>
  );
}
