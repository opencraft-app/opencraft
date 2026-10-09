/** Portable presentation data for the original Hermes Cron client. */
export type AutomationJob = {
  id: string;
  name: string;
  prompt: string;
  schedule: string;
  scheduleDisplay: string;
  enabled: boolean;
  state: string;
  deliver: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: string | null;
  executionStatus: string | null;
  kind: "agent" | "fixed_notification" | "script";
  contextFrom: readonly string[];
  contextHydrated: boolean;
};

export type AutomationDraft = {
  name: string;
  prompt: string;
  schedule: string;
  deliver: string;
};
