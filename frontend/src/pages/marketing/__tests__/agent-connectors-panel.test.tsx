import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as client from "@/lib/connectors-client";
import { ConnectorsPanel } from "@/pages/marketing/agent-connectors-panel";

vi.mock("@/i18n/t", () => ({ t: (s: string) => s }));
vi.mock("@/lib/connectors-client", () => ({
  listInstanceConnectors: vi.fn(),
  enableBuiltinConnector: vi.fn(),
  completeConnectorOAuth: vi.fn(),
  cancelConnectorOAuth: vi.fn(),
  disableBuiltinConnector: vi.fn(),
  retryConnectorDelivery: vi.fn(),
  CONNECTOR_OAUTH_COMPLETE_MESSAGE: "connector.oauth.complete",
}));

beforeEach(() => vi.clearAllMocks());

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
