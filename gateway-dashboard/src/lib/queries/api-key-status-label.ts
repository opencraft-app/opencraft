import type { ApiKeyStatusFilter } from "@/lib/queries/api-key-status-filter";

export function getApiKeyStatusLabel(status: ApiKeyStatusFilter): string {
  switch (status) {
    case "active":
      return "活跃";
    case "revoked":
      return "已撤销";
    case "all":
      return "全部";
  }
}
