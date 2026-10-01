import { t } from "../i18n";
import { ButtonLink } from "./Button";
import { EmptyState } from "./EmptyState";
import { usePageTitle } from "./Layout";

export function NotFound({ home = "/", homeLabel = t("web.common.homeLink") }: { home?: string; homeLabel?: string }) {
  usePageTitle(t("web.common.notFoundHeading"));
  return (
    <EmptyState
      title={t("web.common.notFoundHeading")}
      body={t("web.common.notFoundBody")}
      action={<ButtonLink to={home}>{homeLabel}</ButtonLink>}
    />
  );
}
