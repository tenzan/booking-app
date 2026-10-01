import { addBusinessMinutes } from "./business-hours";
import type { BhCtx } from "./business-hours";
import type { Settings } from "./settings";
import { MIN } from "./time";

export interface ApprovalDeadlines {
  reminderAt: number;
  escalationAt: number;
  expiresAt: number;
}

export function approvalDeadlines(
  createdAt: number,
  startAt: number,
  s: Settings,
  bh: BhCtx
): ApprovalDeadlines {
  // expiresAt = min(created + approvalExpiryBh BH, start − expiryBeforeStartMin)
  const expiryFromCreated = addBusinessMinutes(createdAt, s.approvalExpiryBh * 60, bh);
  const expiryBeforeStart = startAt - s.expiryBeforeStartMin * MIN;
  const expiresAt = Math.max(createdAt, Math.min(expiryFromCreated, expiryBeforeStart));

  // reminderAt = min(created + approvalReminderBh BH, expiresAt − 30 min)
  const reminderFromCreated = addBusinessMinutes(createdAt, s.approvalReminderBh * 60, bh);
  const reminderBeforeExpiry = expiresAt - 30 * MIN;
  const reminderAt = Math.max(createdAt, Math.min(reminderFromCreated, reminderBeforeExpiry));

  // escalationAt = min(created + approvalEscalationBh BH, expiresAt − 30 min)
  const escalationFromCreated = addBusinessMinutes(createdAt, s.approvalEscalationBh * 60, bh);
  const escalationBeforeExpiry = expiresAt - 30 * MIN;
  const escalationAt = Math.max(createdAt, Math.min(escalationFromCreated, escalationBeforeExpiry));

  return { reminderAt, escalationAt, expiresAt };
}

export function minNoticeAt(now: number, s: Settings, bh: BhCtx): number {
  return addBusinessMinutes(now, s.minNoticeBh * 60, bh);
}
