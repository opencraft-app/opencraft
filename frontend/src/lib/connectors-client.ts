/**
 * ai-server 连接器 API client（LightVela P1）。
 *
 * 接口契约来源：ai-server 仓库 controller/connectors.controller.ts
 * （@Controller('api/connectors')）。鉴权两枚头：
 *   X-Product: lightvela（产品标识）
 *   Authorization: Bearer <launch_token>（AgentChat 启动 token，由
 *   `fetchAgentChatLaunchToken` 获取；ai-server 用它调 LightVela introspect
 *   换 user_id——见 ai-server lightVelaOauthRequest.helper.ts）
 *
 * 红线：token 只用于请求头，不落任何缓存/日志；错误信息不含凭据明文。
 */

export const CONNECTOR_OAUTH_COMPLETE_MESSAGE = "connector.oauth.complete";

export type ConnectorStatus =
  | "not_connected"
  | "connected"
  | "expired"
  | "failed"
  | "auth_required";

export interface ConnectorItem {
  key: string;
  name: string;
  connectorType: "mcp_proxy" | "local_cli";
  status: ConnectorStatus;
  authorizedAt?: number;
  /** 已授权但下发未完成（实例离线/版本不满足）时为 true */
  deliveryWarning?: boolean;
}

export interface EnableResult {
  status: "ok" | "auth_required";
  authorizationUrl?: string;
  flowId?: string;
}

function aiServerBase(): string {
  const base = (
    typeof process !== "undefined" ? process.env.NEXT_PUBLIC_AI_SERVER_BASE_URL : ""
  )?.trim();
  if (!base) throw new Error("连接器服务暂不可用，请稍后重试");
  return base.replace(/\/+$/, "");
}

async function post<T>(
  path: string,
  accessToken: string,
  body: Record<string, unknown>,
): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Product": "lightvela",
    Authorization: `Bearer ${accessToken}`,
  };
  const res = await fetch(`${aiServerBase()}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (res.status === 401) throw new Error("登录已过期，请重新登录后再试");
  if (!res.ok) throw new Error(`连接器服务异常（${res.status}）`);
  return (await res.json()) as T;
}

/** 拉取某实例可用的连接器列表与授权状态 */
export async function listInstanceConnectors(
  accessToken: string,
  instanceId: string,
): Promise<ConnectorItem[]> {
  const data = await post<{ items?: ConnectorItem[] }>(
    "/api/connectors/mcp/instance/list",
    accessToken,
    { instanceId },
  );
  return Array.isArray(data.items) ? data.items : [];
}

/** 启用内置连接器；需 OAuth 时返回 auth_required + authorizationUrl/flowId */
export async function enableBuiltinConnector(
  accessToken: string,
  instanceId: string,
  connectorKey: string,
): Promise<EnableResult> {
  return post<EnableResult>("/api/connectors/mcp/builtin/enable", accessToken, {
    instanceId,
    connectorKey,
  });
}

/** 授权回调完成后落库（postMessage 握手成功后调用） */
export async function completeConnectorOAuth(
  accessToken: string,
  instanceId: string,
  connectorKey: string,
  flowId: string,
): Promise<{ ok: boolean }> {
  return post("/api/connectors/oauth/complete", accessToken, {
    instanceId,
    connectorKey,
    flowId,
  });
}

/** 取消进行中的授权流（面板卸载/用户离开时） */
export async function cancelConnectorOAuth(
  accessToken: string,
  instanceId: string,
  connectorKey: string,
  flowId: string,
): Promise<void> {
  await post("/api/connectors/oauth/cancel", accessToken, {
    instanceId,
    connectorKey,
    flowId,
  });
}

/** 断开已连接的连接器 */
export async function disableBuiltinConnector(
  accessToken: string,
  instanceId: string,
  connectorKey: string,
): Promise<void> {
  await post("/api/connectors/mcp/builtin/disable", accessToken, {
    instanceId,
    connectorKey,
  });
}

/** 重试下发（授权成功但实例离线/版本不满足后的补发） */
export async function retryConnectorDelivery(
  accessToken: string,
  instanceId: string,
  connectorKey: string,
): Promise<void> {
  await post("/api/connectors/mcp/builtin/retry-delivery", accessToken, {
    instanceId,
    connectorKey,
  });
}
