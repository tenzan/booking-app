import { useState } from "react";
import { useSearchParams } from "react-router";
import { safePath, useMe } from "../../api";
import { Button, ButtonLink } from "../../components/Button";
import { Card } from "../../components/Card";
import { EmailLinkForm, EmailStrong, LinkSent } from "../../components/EmailLinkForm";
import { PageHeading, usePageTitle, useSignOut } from "../../components/Layout";
import { Skeleton } from "../../components/Spinner";
import { t, tNodes } from "../../i18n";

export default function Start() {
  usePageTitle(t("web.start.heading"));
  const me = useMe();
  const [params] = useSearchParams();
  const next = safePath(params.get("next"));
  const [sentTo, setSentTo] = useState<string | null>(null);

  return (
    <div className="space-y-8">
      <div className="space-y-3">
        <PageHeading>{t("web.start.heading")}</PageHeading>
        {!me.data?.customer && <p className="text-lg text-slate-600 dark:text-slate-300">{t("web.start.lead")}</p>}
      </div>
      {me.isPending ? (
        <Skeleton className="h-64" />
      ) : me.data?.customer ? (
        <SignedIn email={me.data.customer.email} next={next} />
      ) : sentTo ? (
        <LinkSent body={tNodes("web.start.sentBody", { email: <EmailStrong email={sentTo} /> })} onReset={() => setSentTo(null)} />
      ) : (
        <EmailLinkForm
          kind="customer"
          siteKey={me.data?.turnstileSiteKey ?? null}
          next={next}
          label={t("web.start.emailLabel")}
          hint={t("web.start.emailHint")}
          submitLabel={t("web.start.submit")}
          onSent={setSentTo}
        />
      )}
      {!me.data?.customer && !sentTo && <HowItWorks />}
    </div>
  );
}

function SignedIn({ email, next }: { email: string; next: string | null }) {
  const signOut = useSignOut();
  return (
    <Card className="space-y-5">
      <div>
        <h2 className="text-xl font-semibold">{t("web.start.signedInHeading")}</h2>
        <p className="mt-1 break-words text-slate-600 dark:text-slate-400">{t("web.nav.signedInAs", { email })}</p>
      </div>
      <div className="flex flex-col gap-3 sm:flex-row">
        <ButtonLink to={next ?? "/book"} size="lg" className="sm:flex-1">
          {t("web.start.bookNow")}
        </ButtonLink>
        <ButtonLink to="/my" variant="secondary" size="lg" className="sm:flex-1">
          {t("web.nav.myReservations")}
        </ButtonLink>
      </div>
      <Button variant="ghost" onClick={() => signOut.mutate()} loading={signOut.isPending}>
        {t("web.nav.signOut")}
      </Button>
    </Card>
  );
}

function HowItWorks() {
  const steps = [t("web.start.how1"), t("web.start.how2"), t("web.start.how3")];
  return (
    <section aria-labelledby="how-heading">
      <h2 id="how-heading" className="mb-3 text-sm font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400">
        {t("web.start.howHeading")}
      </h2>
      <ol className="space-y-3">
        {steps.map((s, i) => (
          <li key={s} className="flex items-start gap-3">
            <span className="grid size-7 shrink-0 place-items-center rounded-full bg-slate-200 text-sm font-semibold text-slate-700 dark:bg-slate-800 dark:text-slate-200">
              {i + 1}
            </span>
            <span className="pt-0.5 text-slate-700 dark:text-slate-300">{s}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
