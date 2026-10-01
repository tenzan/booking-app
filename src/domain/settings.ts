export type BusinessHours = Array<{ start: number; end: number } | null>;

export interface Settings {
  orgName: string;
  supportPhone: string;
  remoteToolName: string;
  customerInstructions: string;
  durationMin: number;
  bufferBeforeMin: number;
  bufferAfterMin: number;
  slotStepMin: number;
  minNoticeBh: number;
  bookingHorizonDays: number;
  cancelCutoffMin: number;
  maxActivePerAccount: number;
  businessHours: BusinessHours;
  approvalReminderBh: number;
  approvalEscalationBh: number;
  approvalExpiryBh: number;
  expiryBeforeStartMin: number;
  proposalExpiryBh: number;
  proposalExpiryBeforeStartMin: number;
  customerReminderOffsetsMin: number[];
  notifyCustomerOnReassign: boolean;
}

const w = { start: 540, end: 1080 };

export const DEFAULT_SETTINGS: Settings = {
  orgName: "Example Support",
  supportPhone: "",
  remoteToolName: "TeamViewer",
  customerInstructions: "",
  durationMin: 30,
  bufferBeforeMin: 0,
  bufferAfterMin: 10,
  slotStepMin: 30,
  minNoticeBh: 3,
  bookingHorizonDays: 30,
  cancelCutoffMin: 60,
  maxActivePerAccount: 1,
  businessHours: [null, w, w, w, w, w, null],
  approvalReminderBh: 2,
  approvalEscalationBh: 4,
  approvalExpiryBh: 8,
  expiryBeforeStartMin: 60,
  proposalExpiryBh: 24,
  proposalExpiryBeforeStartMin: 120,
  customerReminderOffsetsMin: [1440, 60],
  notifyCustomerOnReassign: false,
};
