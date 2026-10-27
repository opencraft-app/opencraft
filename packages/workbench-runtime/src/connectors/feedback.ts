import { AppServerRpcError } from "@opencraft/appserver-client";

export type ConnectorOperation = "load" | "save" | "check" | "test" | "authorize" | "cancelAuthorization"
  | "connect" | "select" | "disconnect" | "enable" | "disable" | "remove" | "discover" | "add";

const fallback: Record<ConnectorOperation, string> = {
  load: "无法读取此设备上的连接器。请检查设备连接后重试。",
  save: "未能确认配置是否保存。请先查看已配置列表，避免重复添加。",
  check: "未能完成配置检查，请重试。",
  test: "未能完成连接测试。请检查设备网络，稍后重试。",
  authorize: "未能确认授权是否启动。请先检查已打开的授权页面，再重新打开连接器查看状态。",
  cancelAuthorization: "未能确认授权是否取消，正在继续检查结果。",
  connect: "未能完成连接。请检查服务配置后重试。",
  select: "未能确认会话选择是否保存，请重新打开会话连接器检查。",
  disconnect: "未能确认是否已断开，请重新打开连接器检查。",
  enable: "未能确认是否已启用，请刷新列表检查。",
  disable: "未能确认是否已停用，请刷新列表检查。",
  remove: "未能确认是否已删除，请刷新列表检查。",
  discover: "无法读取此设备的 MCP 服务，请检查设备连接后重试。",
  add: "未能确认是否已添加，请重新读取连接器列表。",
};

/** Only exact platform error codes are interpreted. Never echo provider exception text. */
export function connectorErrorMessage(operation: ConnectorOperation, error: unknown): string {
  const code = error instanceof AppServerRpcError && error.code === -32601 ? "unsupported"
    : error instanceof Error ? /^Connector (invalid|invalid-input|conflict|missing|unsupported|authorization-required|authorization-pending|unavailable|cancelled)$/.exec(error.message)?.[1] : undefined;
  if (code === "unsupported") return operation === "load" || operation === "discover"
    ? "此设备暂不支持这项连接器功能。你仍可浏览服务目录。" : "此设备暂不支持这项操作。";
  if (code === "conflict") return "配置已发生变化。请关闭后重新打开连接器，再继续操作。";
  if (code === "missing") return "这个连接器已不存在，请刷新列表。";
  if (code === "invalid" || code === "invalid-input") return "连接信息不符合要求。请检查必填项和填写格式。";
  if (code === "authorization-required") return "当前凭据不可用，请更新凭据或重新登录授权。";
  if (code === "authorization-pending") return "上一次授权尚未结束。请等待结果，或重新连接设备后再试。";
  if (code === "cancelled") return "操作已取消。";
  return fallback[operation];
}
