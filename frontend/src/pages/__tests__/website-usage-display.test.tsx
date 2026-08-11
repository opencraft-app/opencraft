import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WebsitePage } from "@/pages/app/website-page";
import { AgentWebsitePanel } from "@/pages/marketing/agent-website-panel";

vi.mock("@/i18n/t", () => ({
  useT: () => (text: string) => text,
}));

vi.mock("@/lib/auth-api-base", () => ({
  resolveConfiguredAuthApiBaseUrl: () => "https://lightclaw.tech",
}));

vi.mock("@/repositories/http-repositories", () => ({
  readStoredAuthToken: () => "test-session-token",
}));

vi.mock("@/components/domain/agent-section-header", () => ({
  AgentSectionHeader: ({
    title,
    description,
    actions,
  }: {
    title: string;
    description?: string;
    actions?: React.ReactNode;
  }) => (
    <header>
      <h1>{title}</h1>
      {description ? <p>{description}</p> : null}
      {actions}
    </header>
  ),
}));

vi.mock("@/components/site/product-chrome", () => ({
  ProductPageShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/lib/app-navigation", () => ({
  AppLink: ({ children, to }: { children: React.ReactNode; to: string }) => <a href={to}>{children}</a>,
}));

const capabilityResponse = {
  code: "OK",
  message: "success",
  data: {
    max_sites: 1,
    used_sites: 1,
    monthly_traffic_bytes: 10 * 1024 * 1024 * 1024,
    used_traffic_bytes: 66_445,
    storage_bytes: 5 * 1024 * 1024 * 1024,
    used_storage_bytes: 30_054,
    max_artifact_size: 20 * 1024 * 1024,
    max_files: 500,
  },
};

const emptySitesResponse = {
  code: "OK",
  message: "success",
  data: { sites: [], total: 0 },
};

const activeSitesResponse = {
  code: "OK",
  message: "success",
  data: {
    total: 1,
    sites: [
      {
        Id: 1,
        CreatedTime: "2026-08-10T10:00:00Z",
        UpdatedTime: "2026-08-10T10:00:00Z",
        UserID: "user-1",
        SiteID: "site-1",
        PassID: "pass-1",
        BundleID: "bundle-1",
        Name: "销售线索看板",
        Status: "active",
        CloudPath: "users/user-1/sites/site-1",
        PublicURL: "https://site-1.example.com",
        DeletedTime: null,
      },
    ],
  },
};

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

describe("建站权益用量展示", () => {
  let sitesResponse: unknown = emptySitesResponse;

  beforeEach(() => {
    sitesResponse = emptySitesResponse;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      return Promise.resolve(jsonResponse(url.endsWith("/capability") ? capabilityResponse : sitesResponse));
    }));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("独立作品页显示流量和存储的已用量与总量", async () => {
    render(<WebsitePage />);

    expect(await screen.findByText("64.9 KB / 10.0 GB")).toBeInTheDocument();
    expect(screen.getByText("29.3 KB / 5.0 GB")).toBeInTheDocument();
  });

  it("Agent 内嵌面板展示我的工作台模板、配额和列表字段", async () => {
    sitesResponse = activeSitesResponse;

    render(<AgentWebsitePanel />);

    expect(await screen.findByText("我的工作台")).toBeInTheDocument();
    expect(screen.getByText("工作台数量")).toBeInTheDocument();
    expect(screen.getByText("本月访问流量")).toBeInTheDocument();
    expect(screen.getByText("64.9 KB / 10.0 GB")).toBeInTheDocument();
    expect(screen.queryByText("存储空间")).not.toBeInTheDocument();
    expect(screen.getByText("清爽工具台")).toBeInTheDocument();
    expect(screen.getByText("数据看板台")).toBeInTheDocument();
    expect(screen.getByText("运营活动台")).toBeInTheDocument();
    expect(screen.getByText("个人展示台")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /创建我的工作台/ })).toHaveAttribute("href", "/agents/chat");
    expect(screen.getByText("工作台访问地址")).toBeInTheDocument();
    expect(screen.getByText("状态")).toBeInTheDocument();
    expect(screen.getByText("操作")).toBeInTheDocument();
    expect(screen.getByText("https://site-1.example.com")).toBeInTheDocument();
  });

  it("Agent 内嵌面板接口失败时保留模板和创建入口", async () => {
    vi.mocked(fetch).mockRejectedValue(new TypeError("Failed to fetch"));

    render(<AgentWebsitePanel />);

    expect(await screen.findByText("我的工作台")).toBeInTheDocument();
    expect(screen.getByText("清爽工具台")).toBeInTheDocument();
    expect(screen.getByText("数据看板台")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /创建我的工作台/ })).toHaveAttribute("href", "/agents/chat");
    expect(screen.getAllByText("暂不可用").length).toBeGreaterThan(0);
    expect(screen.getByText("暂时无法加载工作台列表")).toBeInTheDocument();
    expect(screen.getByText("托管服务接口暂时不可用，模板和创建入口仍可使用。")).toBeInTheDocument();
    expect(screen.queryByText("Failed to fetch")).not.toBeInTheDocument();
  });
});
