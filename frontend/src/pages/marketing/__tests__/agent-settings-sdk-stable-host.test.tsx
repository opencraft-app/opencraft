import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  hasTeaSdkReadyContent,
  isTeaSdkLoading,
  StableTeaSdkPanelHost,
} from "@/pages/marketing/agent-settings-sdk-stable-host";

function SdkPanelFixture({ state }: { state: "loading" | "ready" }) {
  return (
    <StableTeaSdkPanelHost>
      {state === "loading" ? (
        <div className="lh-std-channel-panel lh-std-channel-panel--loading">
          <div className="lh-std-channel-panel__loader">加载中...</div>
        </div>
      ) : (
        <div className="lh-std-channel-panel">
          <div className="lh-std-channel-panel__grid">
            配置通道后 微信 QQ 企业微信 飞书
          </div>
        </div>
      )}
    </StableTeaSdkPanelHost>
  );
}

describe("StableTeaSdkPanelHost", () => {
  afterEach(() => cleanup());

  it("recognizes TEA SDK loading and ready DOM states", () => {
    const loading = document.createElement("div");
    loading.innerHTML = `
      <div class="lh-std-channel-panel lh-std-channel-panel--loading">
        <div class="lh-std-channel-panel__loader">加载中...</div>
      </div>
    `;
    expect(isTeaSdkLoading(loading)).toBe(true);
    expect(hasTeaSdkReadyContent(loading)).toBe(false);

    const ready = document.createElement("div");
    ready.innerHTML = `<div class="lh-std-channel-panel">配置通道后 微信 QQ</div>`;
    expect(isTeaSdkLoading(ready)).toBe(false);
    expect(hasTeaSdkReadyContent(ready)).toBe(true);
  });

  it("keeps the last ready snapshot visible when the SDK briefly returns to loading", async () => {
    const { rerender } = render(<SdkPanelFixture state="loading" />);

    expect(screen.getByText("加载中...")).toBeVisible();

    rerender(<SdkPanelFixture state="ready" />);

    await waitFor(() => {
      expect(screen.getByText(/配置通道后/)).toBeVisible();
    });

    rerender(<SdkPanelFixture state="loading" />);

    await waitFor(() => {
      expect(screen.getByText(/配置通道后/)).toBeVisible();
    });
    expect(screen.getByText("加载中...")).not.toBeVisible();

    rerender(<SdkPanelFixture state="ready" />);

    await waitFor(() => {
      expect(screen.queryByTestId("tea-sdk-stable-snapshot")).not.toBeInTheDocument();
      expect(screen.getByText(/企业微信/)).toBeVisible();
    });
  });
});
