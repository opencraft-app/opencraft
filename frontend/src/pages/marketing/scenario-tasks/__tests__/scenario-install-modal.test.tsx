import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ScenarioInstallModal } from "../ScenarioInstallModal";
import { getScenarioTaskPack } from "../scenario-packs";

afterEach(() => {
  cleanup();
});

describe("ScenarioInstallModal notification apps", () => {
  it("only shows configured apps, supports multiple selections, and links to channel settings", () => {
    const onEnableDirect = vi.fn();

    render(
      <ScenarioInstallModal
        pack={getScenarioTaskPack("stock-info-digest")}
        botId="bot-1"
        submitting={false}
        enabledChannels={new Set(["wecom", "feishu"])}
        channelStatus="ready"
        onRefreshChannels={vi.fn().mockResolvedValue(undefined)}
        onClose={vi.fn()}
        onRunOnce={vi.fn()}
        onEnableDirect={onEnableDirect}
      />,
    );

    expect(screen.getByRole("button", { name: /企业微信/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /飞书/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^QQ$/ })).toBeNull();
    expect(screen.getByRole("link", { name: /更多通道/ })).toHaveAttribute("href", "/agents/channels");

    fireEvent.click(screen.getByRole("button", { name: /飞书/ }));
    fireEvent.click(screen.getByRole("button", { name: "立即启用" }));

    expect(onEnableDirect).toHaveBeenCalledTimes(1);
    expect(onEnableDirect.mock.calls[0]?.[0]).toMatchObject({
      generatedDeliver: "wecom,feishu",
      generatedDeliverLabel: "企业微信、飞书",
    });
  });

  it("shows a channel-settings empty state when no app is configured", () => {
    render(
      <ScenarioInstallModal
        pack={getScenarioTaskPack("stock-info-digest")}
        botId="bot-1"
        submitting={false}
        enabledChannels={new Set()}
        channelStatus="ready"
        onRefreshChannels={vi.fn().mockResolvedValue(undefined)}
        onClose={vi.fn()}
        onRunOnce={vi.fn()}
        onEnableDirect={vi.fn()}
      />,
    );

    expect(screen.getByText("暂无已配置的通知通道")).toBeTruthy();
    expect(screen.getByRole("link", { name: "去配置" })).toHaveAttribute("href", "/agents/channels");
    expect(screen.getByRole("button", { name: "立即启用" })).toBeDisabled();
  });
});
