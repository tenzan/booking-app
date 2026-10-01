import { t } from "../../i18n";

/** "Appointment confirmed" for an email job's template; an unknown template shows as stored. */
export function templateLabel(template: string): string {
  const key = `web.staff.emails.templates.${template}`;
  const label = t(key);
  return label === key ? template : label;
}
