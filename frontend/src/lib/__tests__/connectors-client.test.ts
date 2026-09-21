import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CONNECTOR_OAUTH_COMPLETE_MESSAGE,
  enableBuiltinConnector,
  listInstanceConnectors,
} from "@/lib/connectors-client";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_AI_SERVER_BASE_URL", "https://ai-server.example.com");
  fetchMock.mockReset();
});
afterEach(() => vi.unstubAllEnvs());

describe("connectors-client", () => {
  it("listInstanceConnectors 携带 x-product 与 launch_token 的 Bearer 头并解析 items", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          items: [
            {
              key: "tencent-meeting",
              name: "腾讯会议",
              connectorType: "local_cli",
              status: "connected",
            },
          ],
        }),
        { status: 200 },
      ),
    );
    const items = await listInstanceConnectors("launch-token-1", "ins-1");
    expect(items[0]?.key).toBe("tencent-meeting");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(
      "https://ai-server.example.com/api/connectors/mcp/instance/list",
    );
    const headers = init.headers as Record<string, string>;
    expect(headers["X-Product"]).toBe("lightvela");
    expect(headers.Authorization).toBe("Bearer launch-token-1");
  });

  it("enableBuiltinConnector 返回 auth_required 时透传 authorizationUrl/flowId", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: "auth_required",
          authorizationUrl: "https://oauth.example.com",
          flowId: "f-1",
        }),
        { status: 200 },
      ),
    );
    const r = await enableBuiltinConnector("launch-token-1", "ins-1", "tencent-meeting");
    expect(r).toEqual({
      status: "auth_required",
      authorizationUrl: "https://oauth.example.com",
      flowId: "f-1",
    });
  });

  it("401 抛出未登录错误（不含 token 明文）", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 401 }));
    try {
      await listInstanceConnectors("launch-token-1", "ins-1");
      expect.unreachable("应抛出错误");
    } catch (err) {
      expect(String(err)).toContain("登录已过期");
      expect(String(err)).not.toContain("launch-token-1");
    }
  });

  it("CONNECTOR_OAUTH_COMPLETE_MESSAGE 事件类型常量稳定", () => {
    expect(CONNECTOR_OAUTH_COMPLETE_MESSAGE).toBe("connector.oauth.complete");
  });
});
