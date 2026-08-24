import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ScenarioInstallModal } from "../ScenarioInstallModal";
import { getScenarioTaskPack, type ScenarioTaskPack } from "../scenario-packs";

afterEach(() => {
  cleanup();
});

describe("ScenarioInstallModal notification apps", () => {
  it("removes an added time slot without leaving an empty reminder input", () => {
    const timeSlotPack: ScenarioTaskPack = {
      ...getScenarioTaskPack("stock-info-digest"),
      id: "time-slot-test",
      quickPromptTemplate: undefined,
      quickPrompt: "提醒我喝水",
      fields: [
        {
          key: "dailyTimes",
          label: "每日提醒时间",
          type: "times",
          defaultValue: "08:00|20:00",
          required: true,
          maxItems: 3,
        },
      ],
      promptBuilder: () => "按用户填写的时间提醒。",
    };

    render(
      <ScenarioInstallModal
        pack={timeSlotPack}
        botId="bot-1"
        submitting={false}
        enabledChannels={new Set(["wecom"])}
        channelStatus="ready"
        onRefreshChannels={vi.fn().mockResolvedValue(undefined)}
        onClose={vi.fn()}
        onRunOnce={vi.fn()}
        onEnableDirect={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("每日提醒时间 1")).toHaveValue("08:00");
    expect(screen.getByLabelText("每日提醒时间 2")).toHaveValue("20:00");

    fireEvent.click(screen.getByRole("button", { name: "添加提醒时间" }));
    expect(screen.getByLabelText("每日提醒时间 3")).toHaveValue("");

    fireEvent.click(screen.getByRole("button", { name: "删除提醒时间 2" }));

    expect(screen.getByLabelText("每日提醒时间 1")).toHaveValue("08:00");
    expect(screen.queryByLabelText("每日提醒时间 2")).toBeNull();
  });

  it("only shows configured apps, supports multiple selections, and links to channel settings", () => {
    const onEnableDirect = vi.fn();

    render(
      <ScenarioInstallModal
        pack={getScenarioTaskPack("stock-info-digest")}
        botId="bot-1"
        submitting={false}
        enabledChannels={new Set(["wecom", "feishu", "slack"])}
        channelStatus="ready"
        onRefreshChannels={vi.fn().mockResolvedValue(undefined)}
        onClose={vi.fn()}
        onRunOnce={vi.fn()}
        onEnableDirect={onEnableDirect}
      />,
    );

    expect(screen.getByRole("button", { name: /企业微信/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /飞书/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Slack/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^QQ$/ })).toBeNull();
    expect(screen.getByRole("link", { name: /更多通道/ })).toHaveAttribute("href", "/agents/channels");

    fireEvent.click(screen.getByRole("button", { name: /飞书/ }));
    fireEvent.click(screen.getByRole("button", { name: /Slack/ }));
    fireEvent.click(screen.getByRole("button", { name: "立即启用" }));

    expect(onEnableDirect).toHaveBeenCalledTimes(1);
    expect(onEnableDirect.mock.calls[0]?.[0]).toMatchObject({
      generatedDeliver: "wecom,feishu,slack",
      generatedDeliverLabel: "企业微信、飞书、Slack",
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
