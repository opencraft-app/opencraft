import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as client from "@/lib/connectors-client";
import { fetchAgentChatLaunchToken } from "@/lib/agentchat-launch-token";
import { ConnectorsPanel } from "@/pages/marketing/agent-connectors-panel";

vi.mock("@/i18n/t", () => ({ t: (s: string) => s }));
vi.mock("@/lib/agentchat-launch-token", () => ({
  fetchAgentChatLaunchToken: vi.fn(async () => ({ token: "launch-token-1" })),
}));
vi.mock("@/lib/connectors-client", () => ({
  listInstanceConnectors: vi.fn(),
  startConnectorOAuth: vi.fn(),
  completeConnectorOAuth: vi.fn(),
  cancelConnectorOAuth: vi.fn(),
  enableBuiltinConnector: vi.fn(),
  detachBuiltinConnector: vi.fn(),
  checkBuiltinConnectorLocal: vi.fn(),
  reportConnectorDelivery: vi.fn(),
  // 真实实现的内联副本（factory 里不能引用被 mock 的模块自身）
  normalizeInstanceConnectors: (data: {
    builtin?: unknown;
    customMcp?: unknown;
  } | null) => ({
    builtin: Array.isArray(data?.builtin) ? (data.builtin as never[]) : [],
    customMcp: Array.isArray(data?.customMcp) ? (data.customMcp as never[]) : [],
  }),
  CONNECTOR_OAUTH_COMPLETE_MESSAGE: "connector.oauth.complete",
}));
vi.mock("@/lib/connector-tat", () => ({
  executeConnectorTat: vi.fn(),
}));

function builtinView(overrides: Partial<client.InstanceBuiltinConnectorView> = {}): client.InstanceBuiltinConnectorView {
  return {
    connectorKey: "tencent-meeting",
    name: "腾讯会议",
    connectorType: "local_cli",
    authType: "instance_local",
    authStatus: "not_required",
    bindingStatus: "active",
    bindingVersion: 1,
    enableStatus: "enabled",
    deliverStatus: "delivered",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NEXT_PUBLIC_AI_SERVER_BASE_URL", "https://ai-server.example.com");
  vi.mocked(fetchAgentChatLaunchToken).mockReset().mockResolvedValue({ token: "launch-token-1" });
  vi.mocked(client.cancelConnectorOAuth).mockResolvedValue({ flowId: "f", connectorKey: "k", status: "cancelled" } as never);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("ConnectorsPanel 列表与状态", () => {
  it("渲染连接器卡片与三态数据（已授权）", async () => {
    vi.mocked(client.listInstanceConnectors).mockResolvedValue({
      builtin: [builtinView({ authStatus: "authorized" })],
      customMcp: [],
    });
    render(<ConnectorsPanel instanceId="ins-1" />);
    expect(await screen.findByText("腾讯会议")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "连接器" })).toBeTruthy();
    expect(screen.getByText("连接常用服务，扩展 Agent 能力边界，帮你完成更多任务")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "应用连接" })).toBeNull();
    expect(screen.queryByText("更多连接器逐步接入中…")).toBeNull();
    expect(await screen.findByText("已授权")).toBeTruthy();
  });

  it("未授权（not_bound）显示去授权按钮", async () => {
    vi.mocked(client.listInstanceConnectors).mockResolvedValue({
      builtin: [builtinView({ bindingStatus: "detached", authStatus: "not_added", deliverStatus: "none" })],
      customMcp: [],
    });
    render(<ConnectorsPanel instanceId="ins-1" />);
    expect(await screen.findByText("尚未授权")).toBeTruthy();
    expect(screen.getByRole("button", { name: "去授权" })).toBeTruthy();
  });

  it("下发失败状态显示重试（单一主按钮，可点击）", async () => {
    vi.mocked(client.listInstanceConnectors).mockResolvedValue({
      builtin: [builtinView({ deliverStatus: "failed" })],
      customMcp: [],
    });
    render(<ConnectorsPanel instanceId="ins-1" />);
    expect(await screen.findByText("下发失败")).toBeTruthy();
    // 失败态合并为单一「重试」主按钮（保授权重发配置；授权失效自动转重新授权）
    const retryButton = screen.getByRole("button", { name: "重试" });
    expect(retryButton).toBeTruthy();
    // busy 失败残留（active: false + failed: true）不再禁用按钮——此前
    // busyItem 误把失败态算作进行中，失败后按钮永久不可点击
    expect((retryButton as HTMLButtonElement).disabled).toBe(false);
  });

  it("空列表显示引导文案", async () => {
    vi.mocked(client.listInstanceConnectors).mockResolvedValue({ builtin: [], customMcp: [] });
    render(<ConnectorsPanel instanceId="ins-1" />);
    expect(await screen.findByText("暂无可用的连接器")).toBeTruthy();
  });

  it("接口返回非数组时按空列表处理（不崩溃）", async () => {
    vi.mocked(client.listInstanceConnectors).mockResolvedValue(
      undefined as unknown as client.InstanceConnectorsResponse,
    );
    render(<ConnectorsPanel instanceId="ins-1" />);
    expect(await screen.findByText("暂无可用的连接器")).toBeTruthy();
  });

  it("列表加载失败显示重试且重试重新发起请求", async () => {
    vi.mocked(client.listInstanceConnectors).mockRejectedValue(
      new Error("连接器服务异常（500）"),
    );
    render(<ConnectorsPanel instanceId="ins-1" />);
    expect(await screen.findByText(/连接器服务异常/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() =>
      expect(client.listInstanceConnectors).toHaveBeenCalledTimes(2),
    );
  });

  it("pending 下发自动恢复：发现 pending+operationId 自动重新 enable 并执行 TAT", async () => {
    // 场景：OAuth 已完成（authorized）但下发中断，状态停在 binding+pending
    vi.mocked(client.listInstanceConnectors).mockResolvedValue({
      builtin: [builtinView({
        connectorKey: "tencent-docs",
        name: "腾讯文档",
        connectorType: "mcp_proxy",
        authType: "oauth",
        authStatus: "authorized",
        bindingStatus: "binding",
        deliverStatus: "pending",
        operationId: "op-recover-1",
        operationAction: "upsert",
      })],
      customMcp: [],
    });
    vi.mocked(client.enableBuiltinConnector).mockResolvedValue({
      status: "ok",
      installId: "i-r",
      installType: "builtin",
      operationId: "op-recover-2",
      bindingVersion: 2,
      tat: {
        protocolVersion: 2,
        action: "upsert",
        installId: "i-r",
        installType: "builtin",
        instanceId: "ins-1",
        runtime: "openclaw",
        scriptName: "connector-runtime.abc12345.sh",
      },
    } as never);
    const { executeConnectorTat } = await import("@/lib/connector-tat");
    vi.mocked(executeConnectorTat).mockResolvedValue({ status: "success", message: "", tatTaskId: "t-r" });
    const noopExecutor = vi.fn(async () => ({ status: "SUCCESS", exitCode: 0, output: "" }));

    render(<ConnectorsPanel instanceId="ins-1" execCommand={noopExecutor} />);
    // 自动恢复：无需点击，列表就绪后自动 enable + TAT + 回写
    await waitFor(() =>
      expect(client.enableBuiltinConnector).toHaveBeenCalledWith(
        "launch-token-1",
        "ins-1",
        "tencent-docs",
      ),
      { timeout: 3000 },
    );
    await waitFor(() => expect(executeConnectorTat).toHaveBeenCalled());
    await waitFor(() =>
      expect(client.reportConnectorDelivery).toHaveBeenCalledWith(
        "launch-token-1",
        expect.objectContaining({ installId: "i-r", status: "success" }),
      ),
    );
  });

  it("launch token 获取失败（实例未就绪）时，点重试应重新发起 token 请求", async () => {
    const err = new Error("DEBUG_NOT_SUPPORTED. debug command not supported in this instance state");
    vi.mocked(fetchAgentChatLaunchToken)
      .mockRejectedValueOnce(err)
      .mockRejectedValueOnce(err);
    render(<ConnectorsPanel instanceId="ins-1" />);
    expect(await screen.findByText(/DEBUG_NOT_SUPPORTED/)).toBeTruthy();
    expect(fetchAgentChatLaunchToken).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() =>
      expect(fetchAgentChatLaunchToken).toHaveBeenCalledTimes(2),
    );
  });
});

describe("ConnectorsPanel 操作", () => {
  const noopExecutor = vi.fn(async () => ({ status: "SUCCESS", exitCode: 0, output: "CONNECTOR_RESULT_JSON={\"status\":\"success\"}" }));

  it("已连接卡片：解除需确认弹窗后调 detach 并执行 TAT + 回写", async () => {
    vi.mocked(client.listInstanceConnectors).mockResolvedValue({
      builtin: [builtinView({ authStatus: "authorized" })],
      customMcp: [],
    });
    vi.mocked(client.detachBuiltinConnector).mockResolvedValue({
      status: "ok",
      installId: "i-1",
      installType: "builtin",
      operationId: "op-1",
      bindingVersion: 2,
      tat: {
        protocolVersion: 2,
        action: "remove",
        installId: "i-1",
        installType: "builtin",
        instanceId: "ins-1",
        runtime: "openclaw",
        scriptName: "connector-runtime.abc12345.sh",
      },
    } as never);
    const { executeConnectorTat } = await import("@/lib/connector-tat");
    vi.mocked(executeConnectorTat).mockResolvedValue({ status: "success", message: "", tatTaskId: "t-1" });

    render(<ConnectorsPanel instanceId="ins-1" execCommand={noopExecutor} />);
    fireEvent.click(await screen.findByRole("button", { name: "解除授权" }));
    expect(screen.getByText(/当前实例下的所有 Bot 都将无法使用该连接器/)).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "确认解除" }));
    await waitFor(() => expect(client.detachBuiltinConnector).toHaveBeenCalled());
    await waitFor(() => expect(executeConnectorTat).toHaveBeenCalled());
    await waitFor(() =>
      expect(client.reportConnectorDelivery).toHaveBeenCalledWith(
        "launch-token-1",
        expect.objectContaining({ installId: "i-1", status: "success" }),
      ),
    );
  });

  it("local_cli 未授权：点去授权走 enable 并执行 TAT 下发", async () => {
    vi.mocked(client.listInstanceConnectors).mockResolvedValue({
      builtin: [builtinView({ bindingStatus: "detached", authStatus: "not_added", deliverStatus: "none" })],
      customMcp: [],
    });
    vi.mocked(client.enableBuiltinConnector).mockResolvedValue({
      status: "ok",
      installId: "i-2",
      installType: "builtin",
      operationId: "op-2",
      bindingVersion: 1,
      tat: {
        protocolVersion: 2,
        action: "local_cli_enable",
        installId: "i-2",
        installType: "builtin",
        instanceId: "ins-1",
        runtime: "openclaw",
        scriptName: "connector-runtime.abc12345.sh",
      },
    } as never);
    const { executeConnectorTat } = await import("@/lib/connector-tat");
    vi.mocked(executeConnectorTat).mockResolvedValue({ status: "success", message: "", tatTaskId: "t-2" });

    render(<ConnectorsPanel instanceId="ins-1" execCommand={noopExecutor} />);
    fireEvent.click(await screen.findByRole("button", { name: "去授权" }));
    await waitFor(() => expect(client.enableBuiltinConnector).toHaveBeenCalled());
    await waitFor(() => expect(executeConnectorTat).toHaveBeenCalled());
    await waitFor(() =>
      expect(client.reportConnectorDelivery).toHaveBeenCalledWith(
        "launch-token-1",
        expect.objectContaining({ action: "local_cli_enable" }),
      ),
    );
  });

  it("OAuth 型未授权：走 startOAuth 授权流（关窗 pending 宽限超窗后才 cancel）", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(client.listInstanceConnectors).mockResolvedValue({
        builtin: [builtinView({
          connectorKey: "tencent-docs",
          name: "腾讯文档",
          connectorType: "mcp_proxy",
          authType: "oauth",
          bindingStatus: "detached",
          authStatus: "not_added",
          deliverStatus: "none",
        })],
        customMcp: [],
      });
      // 弹窗关闭（closed=true）：关窗 ≠ 失败——complete 一直 pending 时，
      // 宽限窗口（10s）内不 cancel，超窗才 cancel 兜底
      vi.stubGlobal("open", vi.fn(() => ({ closed: true, location: { href: "" } }) as unknown as Window));
      vi.mocked(client.startConnectorOAuth).mockResolvedValue({
        authorizeUrl: "https://oauth.example.com/auth",
        state: "s1",
        flowId: "flow-1",
      });
      vi.mocked(client.completeConnectorOAuth).mockResolvedValue({ status: "pending" } as never);

      render(<ConnectorsPanel instanceId="ins-1" execCommand={noopExecutor} />);
      const authButton = screen.findByRole("button", { name: "去授权" });
      await vi.advanceTimersByTimeAsync(100);
      fireEvent.click(await authButton);
      await vi.advanceTimersByTimeAsync(50);
      expect(client.startConnectorOAuth).toHaveBeenCalledWith(
        "launch-token-1",
        "ins-1",
        "tencent-docs",
        expect.any(String),
      );
      // 宽限窗口内（首次关窗轮询 2s + 6s < 10s）：不 cancel
      await vi.advanceTimersByTimeAsync(6_000);
      expect(client.cancelConnectorOAuth).not.toHaveBeenCalled();
      // 超窗（累计 13s > 2s + 10s）：cancel 兜底
      await vi.advanceTimersByTimeAsync(7_000);
      expect(client.cancelConnectorOAuth).toHaveBeenCalledWith(
        "launch-token-1",
        "ins-1",
        "tencent-docs",
        "flow-1",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("OAuth：binding 即完成——complete 返回 binding（带 tat）立即 resolve 执行下发，不傻等", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(client.listInstanceConnectors).mockResolvedValue({
        builtin: [builtinView({
          connectorKey: "tencent-docs",
          name: "腾讯文档",
          connectorType: "mcp_proxy",
          authType: "oauth",
          bindingStatus: "detached",
          authStatus: "not_added",
          deliverStatus: "none",
        })],
        customMcp: [],
      });
      // 用户授权成功、回调页自动关闭，postMessage 丢失：complete 先 pending
      // 后 binding——binding 即授权成功且携带 tat 下发计划，必须立即 resolve
      // 并执行下发（reportDelivery 回写后状态才流转到 completed），不 cancel
      vi.stubGlobal("open", vi.fn(() => ({ closed: true, location: { href: "" } }) as unknown as Window));
      vi.mocked(client.startConnectorOAuth).mockResolvedValue({
        authorizeUrl: "https://oauth.example.com/auth",
        state: "s1",
        flowId: "flow-1",
      });
      const tatPayload = { action: "upsert", installId: "ins-1" } as never;
      vi.mocked(client.completeConnectorOAuth)
        .mockResolvedValueOnce({ status: "pending" } as never)
        .mockResolvedValue({
          status: "binding",
          connectorKey: "tencent-docs",
          installId: "install-1",
          installType: "builtin",
          operationId: "op-1",
          bindingVersion: 1,
          tat: tatPayload,
        } as never);
      vi.mocked(client.reportConnectorDelivery).mockResolvedValue({ status: "ok" } as never);

      render(<ConnectorsPanel instanceId="ins-1" execCommand={noopExecutor} />);
      const authButton = screen.findByRole("button", { name: "去授权" });
      await vi.advanceTimersByTimeAsync(100);
      fireEvent.click(await authButton);
      await vi.advanceTimersByTimeAsync(50);
      // 两个轮询 tick：pending → binding 即 resolve（无需等到 completed）
      await vi.advanceTimersByTimeAsync(5_000);
      expect(client.cancelConnectorOAuth).not.toHaveBeenCalled();
      // binding 响应的 tat 已被执行并 reportDelivery（此前的 bug：binding 被
      // 当 wait 傻等，tat 无人执行，状态停摆至超时）
      expect(client.reportConnectorDelivery).toHaveBeenCalled();
      expect(client.listInstanceConnectors).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
