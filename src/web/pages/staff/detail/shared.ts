import type { ReservationDTO } from "../../../../shared/types";
import { isApiError } from "../../../api";
import { t } from "../../../i18n";

/** What every action panel gets from the detail page. */
export interface PanelProps {
  r: ReservationDTO;
  /** The action went through; `text` is the confirmation to show. */
  onDone: (text: string) => void;
  /** 409 stale: someone else got there first (`current` is the server's copy). */
  onStale: (current: ReservationDTO | undefined) => void;
}

/** Message for a failed action that has no specific handling. */
export function actionErrorText(e: unknown): string {
  if (isApiError(e, 503)) return t("web.errors.busy");
  if (isApiError(e, 429)) return t("web.errors.rateLimited");
  if (isApiError(e, 0)) return t("web.errors.network");
  return t("web.errors.generic");
}
