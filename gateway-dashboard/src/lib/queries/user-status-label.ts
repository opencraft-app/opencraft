export function getUserStatusLabel(status: string): string {
  switch (status) {
    case "active":
      return "活跃";
    case "suspended":
    case "disabled":
      return "已禁用";
    case "deleted":
      return "已删除";
    case "expired":
      return "已过期";
    case "all":
      return "全部";
    default:
      return status;
  }
}
