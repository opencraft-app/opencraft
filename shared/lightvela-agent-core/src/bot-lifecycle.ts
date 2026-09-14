export type BotLifecycle = "running" | "paused" | "draft" | "provisioning" | "failed" | "deleting";

export function normalizeBotLifecycle(status: string): BotLifecycle {
  switch (status.trim().toLowerCase()) {
    case "running":
    case "active":
    case "ready":
    case "succeeded":
    case "success":
      return "running";
    case "creating":
    case "resuming":
    case "provisioning":
    case "pending":
    case "queued":
      return "provisioning";
    case "paused":
      return "paused";
    case "failed":
    case "error":
      return "failed";
    case "deleting":
    case "deleted":
      return "deleting";
    default:
      return "draft";
  }
}
