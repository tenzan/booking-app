import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import { safePath, useMe } from "../../api";
import { Button, ButtonLink } from "../../components/Button";
import { Card } from "../../components/Card";
import { EmailLinkForm, EmailStrong, LinkSent } from "../../components/EmailLinkForm";
import { PageHeading, usePageTitle } from "../../components/Layout";
import { Skeleton } from "../../components/Spinner";
import { t, tNodes } from "../../i18n";
import { useStaffSignOut } from "./StaffLayout";

/** `/staff/login?next=<path>`: the emailed link brings the team member back to `next`. */
export default function Login() {
  usePageTitle(t("web.staff.login.heading"));
  const me = useMe();
  const [params] = useSearchParams();
  const next = safePath(params.get("next"));
  const [sentTo, setSentTo] = useState<string | null>(null);
  // "Use a different email" from the sent confirmation: the form then starts empty.
  const [another, setAnother] = useState(false);
  const anotherAddress = () => {
    setSentTo(null);
    setAnother(true);
  };
  const staff = me.data?.staff ?? null;

  return (
    <div className="mx-auto max-w-[40rem] space-y-8">
      <div className="space-y-3">
        <PageHeading>{t("web.staff.login.heading")}</PageHeading>
        {!staff && <p className="text-lg text-slate-600 dark:text-slate-300">{t("web.staff.login.lead")}</p>}
      </div>
      {me.isPending ? (
        <Skeleton className="h-64" />
      ) : staff ? (
        <SignedIn email={staff.email} next={next} />
      ) : sentTo ? (
        <LinkSent body={tNodes("web.staff.login.sentBody", { email: <EmailStrong email={sentTo} /> })} onReset={anotherAddress} />
      ) : (
        <EmailLinkForm
          kind="staff"
          siteKey={me.data?.turnstileSiteKey ?? null}
          next={next}
          label={t("web.staff.login.emailLabel")}
          submitLabel={t("web.staff.login.submit")}
          onSent={setSentTo}
          startEmpty={another}
        />
      )}
      {!staff && (
        <p className="text-center text-sm text-slate-600 dark:text-slate-400">
          {t("web.staff.login.customerHint")}{" "}
          <Link to="/" className="inline-flex min-h-11 items-center font-medium text-blue-700 underline underline-offset-2 dark:text-blue-300">
            {t("web.staff.login.customerLink")}
          </Link>
        </p>
      )}
    </div>
  );
}

function SignedIn({ email, next }: { email: string; next: string | null }) {
  const signOut = useStaffSignOut();
  return (
    <Card className="space-y-5">
      <div>
        <h2 className="text-xl font-semibold">{t("web.staff.login.signedInHeading")}</h2>
        <p className="mt-1 break-words text-slate-600 dark:text-slate-400">{t("web.nav.signedInAs", { email })}</p>
      </div>
      <ButtonLink to={next ?? "/staff"} size="lg" block>
        {next ? t("web.verify.continue") : t("web.staff.login.toDashboard")}
      </ButtonLink>
      <Button variant="ghost" onClick={() => signOut.mutate()} loading={signOut.isPending}>
        {t("web.nav.signOut")}
      </Button>
    </Card>
  );
}
