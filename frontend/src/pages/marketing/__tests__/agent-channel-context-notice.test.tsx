import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ChannelPanel } from "@/pages/marketing/agent-channel-panel";
import type { ChannelPanelProps } from "@/pages/marketing/agent-config";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ i18n: { language: "zh-CN" } }),
  initReactI18next: { type: "3rdParty", init: () => undefined },
}));

vi.mock("@/i18n/t", () => ({
  // 组件里用它按 locale 格式化日期（Intl），mock 固定成 zh-CN
  useCurrentLocale: () => "zh-CN",
  t: (text: string) => text,
}));

vi.mock("@/pages/marketing/agent-config", () => ({
  useChannelOperations: () => ({
    loading: false,
    productConfig: { isI18n: false },
    configData: { channels: [] },
    currentChannelList: [
      { value: "weixin", channel: "weixin", channel_name: "微信", primaryLabel: "微信" },
    ],
    configureChannel: vi.fn(),
    deleteChannel: vi.fn(),
    deletingChannel: null,
    configuring: false,
    scriptCommands: {},
    executor: {},
    instance: {},
    refresh: vi.fn(),
  }),
  message: { success: vi.fn(), error: vi.fn() },
  HermesQrCodeModal: () => null,
  FeishuIcon: () => null,
  WecomIcon: () => null,
}));

const panelProps = {} as ChannelPanelProps;
const settingsSource = readFileSync(
  join(process.cwd(), "src/pages/marketing/agent-settings-page.tsx"),
  "utf8",
);

describe("Agent channel contextual notice", () => {
  it("renders the notice after the channel description and before the cards", () => {
    render(
      <ChannelPanel
        {...panelProps}
        afterDescription={<div data-testid="channel-context-notice">微信已由其他 Bot 占用</div>}
      />,
    );

    const title = screen.getByRole("heading", { name: "通道" });
    const description = screen.getByText("配置通道后，即可在聊天软件中与你的云端智能体伙伴对话");
    const notice = screen.getByTestId("channel-context-notice");
    const card = screen.getByRole("heading", { name: "微信" }).closest(".lh-std-channel-panel__card");
    if (!card) throw new Error("Channel card was not rendered");

    expect(title.compareDocumentPosition(description) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(description.compareDocumentPosition(notice) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(notice.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("passes the occupied-Weixin notice through the channel description slot", () => {
    expect(settingsSource).toContain(
      "channelAfterDescription={weixinOccupiedByOther && activeBot.weixinOwner ? (",
    );
    expect(settingsSource).toContain("afterDescription={channelAfterDescription}");
    expect(settingsSource).not.toContain(
      '<>\n                              {weixinOccupiedByOther && activeBot.weixinOwner && (',
    );
  });
});
