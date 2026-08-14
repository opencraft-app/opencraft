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
  AgentSectionHeader: ({ title }: { title: string }) => <h1>{title}</h1>,
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

const sitesResponse = {
  code: "OK",
  message: "success",
  data: { sites: [], total: 0 },
};

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

describe("建站权益用量展示", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      return Promise.resolve(jsonResponse(url.endsWith("/capability") ? capabilityResponse : sitesResponse));
    }));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it.each([
    ["Agent 内嵌面板", AgentWebsitePanel],
    ["独立作品页", WebsitePage],
  ])("%s 显示流量和存储的已用量与总量", async (_name, Component) => {
    render(<Component />);

    expect(await screen.findByText("64.9 KB / 10.0 GB")).toBeInTheDocument();
    expect(screen.getByText("29.3 KB / 5.0 GB")).toBeInTheDocument();
  });
});
