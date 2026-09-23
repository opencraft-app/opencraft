/**
 * ai-server 连接器 API client（LightVela）。
 *
 * 接口契约来源：ai-server 仓库 controller/connectors.controller.ts
 * （@Controller('api/connectors')）；数据模型对齐 AgentChat-web
 * src/common/api/connectors.ts（同一服务端，双方共用契约）。
 *
 * 鉴权两枚头：
 *   X-Product: lightvela（产品标识）
 *   Authorization: Bearer <launch_token>（AgentChat 启动 token，由
 *   `fetchAgentChatLaunchToken` 获取；ai-server 用它调 LightVela introspect
 *   换 user_id——见 ai-server lightVelaOauthRequest.helper.ts）
 *
 * 红线：token 只用于请求头，不落任何缓存/日志；错误信息不含凭据明文。
 */

export const CONNECTOR_OAUTH_COMPLETE_MESSAGE = "connector.oauth.complete";

/** 连接器运行协议版本（与 AgentChat-web / ai-server 三方约定） */
export const CONNECTOR_OPERATION_PROTOCOL_VERSION = 2;

// ─── 数据模型（对齐 ai-server list 返回；三态：授权/绑定/下发 分层） ───

export type ConnectorType = "mcp_proxy" | "local_cli";
export type ConnectorAuthType = "oauth" | "tencent_cloud_oauth" | "instance_local";
export type ConnectorAuthStatus =
  | "not_added"
  | "authorizing"
  | "authorized"
  | "expired"
  | "revoked"
  | "not_required";
export type ConnectorBindingStatus =
  | "detached"
  | "authorizing"
  | "binding"
  | "active"
  | "detaching"
  | "error";

/** 实例级官方连接器视图（listInstance 返回行） */
export interface InstanceBuiltinConnectorView {
  connectorKey: string;
  name: string;
  connectorType?: ConnectorType;
  authType: ConnectorAuthType;
  authStatus: ConnectorAuthStatus;
  /** 实例绑定状态（2026-07 实例级改版契约） */
  bindingStatus: ConnectorBindingStatus;
  bindingVersion: number;
  pendingFlowId?: string;
  operationId?: string;
  operationAction?: string;
  /** 已授权账号（多账号凭证模型的当前绑定） */
  account?: {
    id: number;
    displayName?: string;
    externalUserIdMasked: string;
  };
  enableStatus: "enabled" | "disabled" | string;
  deliverStatus: string;
  deliverError?: string;
  instanceAuthStatus?: string;
  statusSource?: "cloud_auth" | "last_delivery" | "instance_check";
}

export interface InstanceConnectorsResponse {
  builtin: InstanceBuiltinConnectorView[];
  customMcp: Array<Record<string, unknown>>;
}

// ─── TAT 下发（对齐 AgentChat ConnectorTatPayload；P1 只消费，不构造） ───

export type ConnectorTatAction =
  | "upsert"
  | "remove"
  | "local_cli_enable"
  | "local_cli_status"
  | "local_cli_logout"
  | "batch_status";

export interface ConnectorTatPayload {
  executionSource?: "native" | "plugin";
  ownershipProof?: string;
  protocolVersion: number;
  action: ConnectorTatAction;
  installId: string;
  installType: "builtin" | "custom";
  instanceId: string;
  runtime: string;
  scriptName: string;
  server?: {
    name: string;
    type: "http";
    url: string;
    headers: Record<string, string>;
  };
  removeNames?: string[];
  name?: string;
  connectorKey?: string;
  localCli?: unknown;
  operationId?: string;
}

/** enable/detach/complete 等接口的响应（含 TAT 下发计划） */
export interface ConnectorEnableResponse {
  status: string;
  authStatus?: string;
  authorizeUrl?: string;
  state?: string;
  flowId?: string;
  installId?: string;
  installType?: "builtin" | "custom";
  operationId?: string;
  bindingVersion?: number;
  tat?: ConnectorTatPayload;
}

export interface OAuthFlowResponse {
  authorizeUrl: string;
  state: string;
  flowId: string;
}

export interface OAuthCompletionResponse extends ConnectorEnableResponse {
  flowId: string;
  connectorKey: string;
  status:
    | "pending"
    | "completed"
    | "superseded"
    | "binding"
    | "active"
    | "expired"
    | "cancelled";
  expiresAt?: number;
}

// ─── HTTP 基座 ───

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
  const envelope = (await res.json().catch(() => ({}))) as {
    code?: number;
    data?: unknown;
    message?: string;
  };
  // tnode 标准响应信封 {code, data, message}：code !== 0 视为业务错误；
  // 无信封的响应原样返回（与 AgentChat postJson 的 data?.data ?? data 一致）
  if (typeof envelope?.code === "number" && envelope.code !== 0) {
    throw new Error(envelope.message || `连接器服务异常（${envelope.code}）`);
  }
  return (envelope.data ?? envelope) as T;
}

/** 将接口返回统一为 {builtin, customMcp} 结构（防御非数组/空响应） */
export function normalizeInstanceConnectors(
  data?: Partial<InstanceConnectorsResponse> | null,
): InstanceConnectorsResponse {
  return {
    builtin: Array.isArray(data?.builtin) ? data.builtin : [],
    customMcp: Array.isArray(data?.customMcp) ? data.customMcp : [],
  };
}

// ─── 接口 ───

/** 拉取某实例可用的连接器列表与授权/下发状态 */
export async function listInstanceConnectors(
  accessToken: string,
  instanceId: string,
): Promise<InstanceConnectorsResponse> {
  return normalizeInstanceConnectors(
    await post<Partial<InstanceConnectorsResponse>>(
      "/api/connectors/mcp/instance/list",
      accessToken,
      { instanceId },
    ),
  );
}

/** 发起 OAuth 授权流（OAuth 型连接器「去授权」入口） */
export async function startConnectorOAuth(
  accessToken: string,
  instanceId: string,
  connectorKey: string,
  redirectAfter?: string,
): Promise<OAuthFlowResponse> {
  return post<OAuthFlowResponse>("/api/connectors/oauth/start", accessToken, {
    instanceId,
    connectorKey,
    ...(redirectAfter ? { redirectAfter } : {}),
  });
}

/** 完成 OAuth（响应含 TAT 下发计划，直接用于 finishOperation） */
export async function completeConnectorOAuth(
  accessToken: string,
  instanceId: string,
  connectorKey: string,
  flowId: string,
): Promise<OAuthCompletionResponse> {
  return post<OAuthCompletionResponse>("/api/connectors/oauth/complete", accessToken, {
    instanceId,
    connectorKey,
    flowId,
  });
}

/** 取消 OAuth flow（用户关窗/超时兜底） */
export async function cancelConnectorOAuth(
  accessToken: string,
  instanceId: string,
  connectorKey: string,
  flowId: string,
): Promise<OAuthCompletionResponse> {
  return post<OAuthCompletionResponse>("/api/connectors/oauth/cancel", accessToken, {
    instanceId,
    connectorKey,
    flowId,
  });
}

/**
 * 启用官方连接器（local_cli 型授权后的下发入口；OAuth 型授权前置走 startOAuth）。
 * 响应携带 TAT 下发计划。
 */
export async function enableBuiltinConnector(
  accessToken: string,
  instanceId: string,
  connectorKey: string,
): Promise<ConnectorEnableResponse> {
  return post<ConnectorEnableResponse>("/api/connectors/mcp/builtin/enable", accessToken, {
    instanceId,
    connectorKey,
  });
}

/**
 * 解除官方连接器（2026-07 实例级契约：只移除当前实例配置并清除实例绑定，
 * 不撤销服务端 OAuth 凭证；重连无需重新授权）。响应携带 TAT remove 计划。
 */
export async function detachBuiltinConnector(
  accessToken: string,
  instanceId: string,
  connectorKey: string,
): Promise<ConnectorEnableResponse> {
  return post<ConnectorEnableResponse>("/api/connectors/mcp/builtin/detach", accessToken, {
    instanceId,
    connectorKey,
  });
}

/** 单连接器实例侧状态检查（local_cli 授权轮询用；响应含 TAT） */
export async function checkBuiltinConnectorLocal(
  accessToken: string,
  instanceId: string,
  connectorKey: string,
): Promise<ConnectorEnableResponse> {
  return post<ConnectorEnableResponse>("/api/connectors/mcp/builtin/check-local", accessToken, {
    instanceId,
    connectorKey,
  });
}

/** TAT 执行结果回写（前端执行完下发命令后调用，服务端更新 deliver 状态） */
export async function reportConnectorDelivery(
  accessToken: string,
  params: {
    installId: string;
    installType: "builtin" | "custom";
    operationId: string;
    bindingVersion: number;
    action: ConnectorTatAction;
    status: string;
    tatTaskId?: string;
    error?: string;
  },
): Promise<{ success: boolean; stale?: boolean }> {
  return post<{ success: boolean; stale?: boolean }>(
    "/api/connectors/mcp/delivery/report",
    accessToken,
    params,
  );
}

/**
 * 实例 API key（mcp_proxy 型连接器下发时替换 TAT 里的
 * ${AGENTCHAT_API_KEY} 占位符——AgentChat materialize 模式）。
 * 鉴权同其他连接器接口：launch_token + X-Product。
 */
export async function createConnectorApiKey(
  accessToken: string,
  params: {
    name: string;
    device_id: string;
    device_type: string;
    region: string;
    expires_in: number;
  },
): Promise<{ client_id: string; access_token: string; expires_in: number }> {
  return post("/bot/createToken", accessToken, params);
}
