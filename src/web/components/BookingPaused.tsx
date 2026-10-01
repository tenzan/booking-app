import { useEffect, useRef } from "react";
import { t, tNodes } from "../i18n";
import { Card } from "./Card";

/**
 * Calm notice shown instead of the booking UI while an administrator has paused online booking.
 * `autoFocus` moves focus to the heading, for when it replaces a step the customer was already using.
 */
export function BookingPaused({ supportPhone, autoFocus = false }: { supportPhone: string; autoFocus?: boolean }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (autoFocus) heading.current?.focus({ preventScroll: true });
  }, [autoFocus]);

  const phone = supportPhone.trim();
  return (
    <Card className="space-y-3">
      <h2 ref={heading} tabIndex={-1} className="text-xl font-semibold outline-none">
        {t("web.start.pausedHeading")}
      </h2>
      <p className="text-slate-700 dark:text-slate-300">
        {phone ? (
          tNodes("web.start.pausedBodyPhone", {
            phone: (
              <a
                href={`tel:${phone.replace(/[^0-9+]/g, "")}`}
                className="inline-flex min-h-11 items-center font-semibold whitespace-nowrap text-blue-700 underline underline-offset-2 dark:text-blue-300"
              >
                {phone}
              </a>
            ),
          })
        ) : (
          t("web.start.pausedBodyNoPhone")
        )}
      </p>
      <p className="text-sm text-slate-600 dark:text-slate-400">{t("web.start.pausedExisting")}</p>
    </Card>
  );
}
