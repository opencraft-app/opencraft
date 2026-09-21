import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as client from "@/lib/connectors-client";
import { ConnectorsPanel } from "@/pages/marketing/agent-connectors-panel";

vi.mock("@/i18n/t", () => ({ t: (s: string) => s }));
vi.mock("@/lib/agentchat-launch-token", () => ({
  fetchAgentChatLaunchToken: vi.fn(async () => ({ token: "launch-token-1" })),
}));
vi.mock("@/lib/connectors-client", () => ({
  listInstanceConnectors: vi.fn(),
  enableBuiltinConnector: vi.fn(),
  completeConnectorOAuth: vi.fn(),
  cancelConnectorOAuth: vi.fn(),
  disableBuiltinConnector: vi.fn(),
  retryConnectorDelivery: vi.fn(),
  CONNECTOR_OAUTH_COMPLETE_MESSAGE: "connector.oauth.complete",
}));

beforeEach(() => {
  vi.clearAllMocks();
  // 每例独立注入 OAuth 流测试所需的 env；unstubAllGlobals 统一放 afterEach，
  // 避免用例中途 unstub 清掉 localStorage stub 造成跨用例污染。
  vi.stubEnv("NEXT_PUBLIC_AI_SERVER_BASE_URL", "https://ai-server.example.com");
  // 兜底：所有异步 API 默认返回 resolved promise（与真实契约一致），
  // 用例再用 mockResolvedValue 覆盖具体返回值。
  vi.mocked(client.cancelConnectorOAuth).mockResolvedValue(undefined);
  vi.mocked(client.completeConnectorOAuth).mockResolvedValue({ ok: true });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("ConnectorsPanel", () => {
  it("渲染连接器卡片与状态徽标", async () => {
    vi.mocked(client.listInstanceConnectors).mockResolvedValue([
      {
        key: "tencent-meeting",
        name: "腾讯会议",
        connectorType: "local_cli",
        status: "not_connected",
      },
      {
        key: "tencent-docs",
        name: "腾讯文档",
        connectorType: "mcp_proxy",
        status: "connected",
        authorizedAt: 1_700_000_000_000,
      },
    ]);
    render(<ConnectorsPanel instanceId="ins-1" />);
    expect(await screen.findByText("腾讯会议")).toBeTruthy();
    expect(screen.getByText("腾讯文档")).toBeTruthy();
    expect(screen.getByText("CLI")).toBeTruthy();
    expect(screen.getByText("MCP")).toBeTruthy();
    expect(screen.getByText("已连接")).toBeTruthy();
  });

  it("下发警告状态显示同步提示", async () => {
    vi.mocked(client.listInstanceConnectors).mockResolvedValue([
      {
        key: "tencent-meeting",
        name: "腾讯会议",
        connectorType: "local_cli",
        status: "connected",
        deliveryWarning: true,
      },
    ]);
    render(<ConnectorsPanel instanceId="ins-1" />);
    expect(await screen.findByText(/等待 Agent 在线后同步/)).toBeTruthy();
  });

  it("空列表显示引导文案", async () => {
    vi.mocked(client.listInstanceConnectors).mockResolvedValue([]);
    render(<ConnectorsPanel instanceId="ins-1" />);
    expect(await screen.findByText("暂无可用的连接器")).toBeTruthy();
  });

  it("加载失败显示重试且不抛错", async () => {
    vi.mocked(client.listInstanceConnectors).mockRejectedValue(
      new Error("登录已过期，请重新登录后再试"),
    );
    render(<ConnectorsPanel instanceId="ins-1" />);
    expect(await screen.findByText(/登录已过期/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() =>
      expect(client.listInstanceConnectors).toHaveBeenCalledTimes(2),
    );
  });
});

describe("ConnectorsPanel OAuth 流程", () => {
  it("点连接：auth_required 时打开授权窗口并监听 postMessage 完成", async () => {
    const windowOpen = vi.fn(() => ({ closed: false }) as unknown as Window);
    vi.stubGlobal("open", windowOpen);
    vi.mocked(client.listInstanceConnectors).mockResolvedValue([
      {
        key: "tencent-meeting",
        name: "腾讯会议",
        connectorType: "local_cli",
        status: "not_connected",
      },
    ]);
    vi.mocked(client.enableBuiltinConnector).mockResolvedValue({
      status: "auth_required",
      authorizationUrl: "https://oauth.example.com/auth",
      flowId: "flow-1",
    });
    vi.mocked(client.completeConnectorOAuth).mockResolvedValue({ ok: true });
    render(<ConnectorsPanel instanceId="ins-1" />);
    fireEvent.click(await screen.findByRole("button", { name: "连接" }));
    // 不带 noopener：ai-server 回调页依赖 window.opener.postMessage 回执
    await waitFor(() =>
      expect(windowOpen).toHaveBeenCalledWith("https://oauth.example.com/auth", "_blank"),
    );
    // 模拟 ai-server 回调页 postMessage（合法 origin）
    fireEvent(
      window,
      new MessageEvent("message", {
        origin: "https://ai-server.example.com",
        data: {
          type: "connector.oauth.complete",
          flowId: "flow-1",
          connectorKey: "tencent-meeting",
          status: "ok",
        },
      }),
    );
    await waitFor(() =>
      expect(client.completeConnectorOAuth).toHaveBeenCalledWith(
        "launch-token-1",
        "ins-1",
        "tencent-meeting",
        "flow-1",
      ),
    );
    await waitFor(() =>
      expect(client.listInstanceConnectors).toHaveBeenCalledTimes(2),
    );
  });

  it("点连接：enable 直接成功（无需 OAuth）时仅刷新列表", async () => {
    vi.mocked(client.listInstanceConnectors).mockResolvedValue([
      { key: "x", name: "X", connectorType: "mcp_proxy", status: "not_connected" },
    ]);
    vi.mocked(client.enableBuiltinConnector).mockResolvedValue({ status: "ok" });
    render(<ConnectorsPanel instanceId="ins-1" />);
    fireEvent.click(await screen.findByRole("button", { name: "连接" }));
    await waitFor(() =>
      expect(client.listInstanceConnectors).toHaveBeenCalledTimes(2),
    );
    expect(client.completeConnectorOAuth).not.toHaveBeenCalled();
  });

  it("postMessage origin 不匹配时忽略（安全）", async () => {
    vi.mocked(client.listInstanceConnectors).mockResolvedValue([
      {
        key: "tencent-meeting",
        name: "腾讯会议",
        connectorType: "local_cli",
        status: "not_connected",
      },
    ]);
    vi.mocked(client.enableBuiltinConnector).mockResolvedValue({
      status: "auth_required",
      authorizationUrl: "https://oauth.example.com/auth",
      flowId: "flow-9",
    });
    vi.stubGlobal("open", vi.fn(() => ({}) as unknown as Window));
    render(<ConnectorsPanel instanceId="ins-1" />);
    fireEvent.click(await screen.findByRole("button", { name: "连接" }));
    fireEvent(
      window,
      new MessageEvent("message", {
        origin: "https://evil.example.com",
        data: {
          type: "connector.oauth.complete",
          flowId: "flow-9",
          connectorKey: "tencent-meeting",
        },
      }),
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(client.completeConnectorOAuth).not.toHaveBeenCalled();
  });
});

describe("ConnectorsPanel 断开与重试", () => {
  it("已连接卡片：断开需确认弹窗后调用 disable", async () => {
    vi.mocked(client.listInstanceConnectors).mockResolvedValue([
      {
        key: "tencent-meeting",
        name: "腾讯会议",
        connectorType: "local_cli",
        status: "connected",
      },
    ]);
    vi.mocked(client.disableBuiltinConnector).mockResolvedValue(undefined);
    render(<ConnectorsPanel instanceId="ins-1" />);
    fireEvent.click(await screen.findByRole("button", { name: "断开" }));
    // 确认弹窗
    fireEvent.click(screen.getByRole("button", { name: "确认断开" }));
    await waitFor(() =>
      expect(client.disableBuiltinConnector).toHaveBeenCalledWith(
        "launch-token-1",
        "ins-1",
        "tencent-meeting",
      ),
    );
    await waitFor(() =>
      expect(client.listInstanceConnectors).toHaveBeenCalledTimes(2),
    );
  });

  it("下发警告卡片：显示重试下发按钮并调用 retry", async () => {
    vi.mocked(client.listInstanceConnectors).mockResolvedValue([
      {
        key: "tencent-meeting",
        name: "腾讯会议",
        connectorType: "local_cli",
        status: "connected",
        deliveryWarning: true,
      },
    ]);
    vi.mocked(client.retryConnectorDelivery).mockResolvedValue(undefined);
    render(<ConnectorsPanel instanceId="ins-1" />);
    fireEvent.click(await screen.findByRole("button", { name: "重试同步" }));
    await waitFor(() =>
      expect(client.retryConnectorDelivery).toHaveBeenCalledWith(
        "launch-token-1",
        "ins-1",
        "tencent-meeting",
      ),
    );
  });
});

describe("ConnectorsPanel launch token", () => {
  it("launch token 获取失败时显示错误且不调连接器接口", async () => {
    const { fetchAgentChatLaunchToken } = await import("@/lib/agentchat-launch-token");
    vi.mocked(fetchAgentChatLaunchToken).mockRejectedValue(
      new Error("未登录，无法获取 AgentChat 启动 token"),
    );
    render(<ConnectorsPanel instanceId="ins-1" />);
    expect(
      await screen.findByText(/未登录，无法获取 AgentChat 启动 token/),
    ).toBeTruthy();
    await new Promise((r) => setTimeout(r, 20));
    expect(client.listInstanceConnectors).not.toHaveBeenCalled();
  });
});
