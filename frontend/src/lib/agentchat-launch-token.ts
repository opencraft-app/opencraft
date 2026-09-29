/**
 * AgentChat（LightVela）启动 token 获取。
 *
 * 接口：`POST /v1/instances/:instanceId/agentchat/launch-token`（LightVela 后端），
 * 需带主站 Bearer 登录态；返回 `launch_token`（TTL 默认 24h）。
 *
 * 用途：调用 ai-server 连接器等 AgentChat 体系接口时，ai-server 以
 * `Authorization: Bearer <launch_token>` 调 LightVela introspect 接口换取
 * user_id / instance_id（见 ai-server `helper/lightVelaOauthRequest.helper.ts`）。
 * 注意：launch_token ≠ 主站登录 token，两者不可互换。
 */

import { resolveConfiguredAuthApiBaseUrl } from "@/lib/auth-api-base";
import { readStoredAuthToken } from "@/repositories/http-repositories";

const AUTH_SERVICE_UNAVAILABLE_MESSAGE = "无法确定登录服务地址，请刷新页面后重试";

/**
 * 拉取一个 AgentChat 启动 token。
 * @param instanceId 运行时实例 ID（agent-settings 的 runtime instance id）
 * @returns token 及过期时刻（expiresAt，Unix 秒；后端未返回为 undefined），失败抛错
 */
export async function fetchAgentChatLaunchToken(
  instanceId: string,
  signal?: AbortSignal,
): Promise<{ token: string; expiresAt?: number }> {
  const baseUrl = resolveConfiguredAuthApiBaseUrl();
  if (!baseUrl) {
    throw new Error(AUTH_SERVICE_UNAVAILABLE_MESSAGE);
  }
  const authToken = readStoredAuthToken();
  if (!authToken) {
    throw new Error("未登录，无法获取 AgentChat 启动 token");
  }

  const url = `${baseUrl.replace(/\/$/, "")}/v1/instances/${encodeURIComponent(instanceId)}/agentchat/launch-token`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${authToken}`,
    },
    body: "{}",
    signal,
  });

  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const body = (await response.json()) as { code?: string; message?: string };
      if (body?.message) detail = `${body.code ?? response.status}: ${body.message}`;
    } catch {
      // 忽略响应体解析错误
    }
    throw new Error(detail);
  }

  const json = (await response.json()) as {
    code?: string;
    data?: { launch_token?: string; expires_at?: number };
    message?: string;
  };
  const token = json?.data?.launch_token;
  if (!token) {
    throw new Error(json?.message || "返回数据缺少 launch_token");
  }
  const expiresAt =
    typeof json?.data?.expires_at === "number" ? json.data.expires_at : undefined;
  return { token, expiresAt };
}
