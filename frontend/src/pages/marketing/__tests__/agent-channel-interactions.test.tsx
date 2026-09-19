import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChannelPanel } from "../agent-channel-panel";
import type { ChannelPanelProps } from "../agent-config";

const mock = vi.hoisted(() => ({
  configure: vi.fn(), remove: vi.fn(), qr: vi.fn(), wecom: vi.fn(), refresh: vi.fn(),
  success: vi.fn(), error: vi.fn(), bound: [] as string[], loading: false,
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ i18n: { language: "zh-CN" } }), initReactI18next: { type: "3rdParty", init() {} } }));
vi.mock("@/i18n/t", () => ({ t: (text: string, values?: Record<string, string>) => text.replace(/\{\{(.*?)\}\}/g, (_, key: string) => values?.[key.trim()] ?? key) }));
vi.mock("../agent-config", async () => {
  const React = await import("react");
  return {
    useChannelOperations: () => ({
      loading: mock.loading, productConfig: { isI18n: true },
      configData: { channels: mock.bound.map((value) => ({ value, enabled: true })) },
      currentChannelList: ["qqbot", "dingtalk", "slack", "wecom", "weixin"].map((value) => ({ value, channel: value, channel_name: value, primaryLabel: value })),
      configureChannel: mock.configure, deleteChannel: mock.remove,
      deletingChannel: null, configuring: false, scriptCommands: {}, executor: {}, instance: {}, refresh: mock.refresh,
    }),
    message: { success: mock.success, error: mock.error },
    HermesQrCodeModal: React.forwardRef((_, ref) => {
      React.useImperativeHandle(ref, () => ({ startQrCodeFlow: mock.qr, startWecomAuthFlow: mock.wecom }));
      return null;
    }),
    FeishuIcon: () => null, WecomIcon: () => null,
  };
});
function card(name: string) { return screen.getByRole("heading", { name }).closest(".lh-std-channel-panel__card") as HTMLElement; }
beforeEach(() => { vi.clearAllMocks(); mock.bound = []; mock.loading = false; mock.configure.mockResolvedValue(true); mock.remove.mockResolvedValue(true); });
afterEach(cleanup);
describe("ChannelPanel Radix interactions", () => {
  it("keeps the channel page hidden behind the centered first-load state", () => {
    mock.loading = true;
    render(<ChannelPanel {...{} as ChannelPanelProps} />);

    const status = screen.getByRole("status");
    expect(status).toHaveClass("min-h-[min(60vh,520px)]", "items-center", "justify-center");
    expect(screen.queryByRole("heading", { name: "通道" })).not.toBeInTheDocument();
  });

  it.each(["qqbot", "dingtalk"])("keeps %s manual binding, trimming and success draft clearing", async (channel) => {
    const user = userEvent.setup();
    render(<ChannelPanel {...{} as ChannelPanelProps} />);
    await user.click(within(card(channel)).getByRole("button", { name: "+ 连接" }));
    screen.getByRole("radio", { name: /扫码连接/ }).focus();
    await user.keyboard("{ArrowRight}");
    const manualLabel = channel === "qqbot" ? /App ID \/ Secret 绑定/ : /Client ID \/ Secret 绑定/;
    expect(screen.getByRole("radio", { name: manualLabel })).toHaveFocus();
    await user.keyboard(" ");
    await waitFor(() => expect(screen.getByRole("radio", { name: manualLabel })).toBeChecked());
    await user.click(screen.getByRole("button", { name: "确认" }));
    const firstLabel = channel === "qqbot" ? "App ID" : "Client ID";
    const secondLabel = channel === "qqbot" ? "App Secret" : "Client Secret";
    await waitFor(() => expect(screen.getByLabelText(firstLabel)).toHaveFocus());
    await user.type(screen.getByLabelText(firstLabel), " app-id ");
    await user.type(screen.getByLabelText(secondLabel), " app-secret ");
    await user.click(screen.getByRole("button", { name: channel === "qqbot" ? "绑定 QQ 机器人" : "绑定钉钉机器人" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(mock.configure).toHaveBeenCalledWith({ channelValue: channel, channelIdValue: "app-id", channelKeyValue: "app-secret" });
    expect(mock.qr).not.toHaveBeenCalled();
    await user.click(within(card(channel)).getByRole("button", { name: "+ 连接" }));
    screen.getByRole("radio", { name: /扫码连接/ }).focus();
    await user.keyboard("{ArrowRight}");
    await user.keyboard(" ");
    await user.click(screen.getByRole("button", { name: "确认" }));
    expect(screen.getByLabelText(firstLabel)).toHaveValue("");
    expect(screen.getByLabelText(secondLabel)).toHaveValue("");
  });

  it("opens connection methods as a keyboard dialog and restores its trigger on Escape", async () => {
    const user = userEvent.setup();
    render(<ChannelPanel {...{} as ChannelPanelProps} />);
    const trigger = within(card("qqbot")).getByRole("button", { name: "+ 连接" });
    trigger.focus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("dialog", { name: "选择 QQ 连接方式" })).toHaveAccessibleDescription("请选择适合你的连接方式");
    expect(screen.getAllByRole("radio")).toHaveLength(2);
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(mock.qr).not.toHaveBeenCalled();
    expect(mock.configure).not.toHaveBeenCalled();
  });
  it("keeps Slack's two credentials on failure and trims both on submit", async () => {
    mock.configure.mockResolvedValue(false);
    const user = userEvent.setup();
    render(<ChannelPanel {...{} as ChannelPanelProps} />);
    await user.click(within(card("slack")).getByRole("button", { name: "+ 连接" }));
    const dialog = screen.getByRole("dialog", { name: "连接 Slack" });
    const submit = within(dialog).getByRole("button", { name: "绑定 Slack" });
    await user.type(within(dialog).getByLabelText("Bot Token"), " first-token ");
    expect(submit).toBeDisabled();
    await user.type(within(dialog).getByLabelText("App Token"), " second-token ");
    await user.click(submit);
    await waitFor(() => expect(mock.configure).toHaveBeenCalledWith({ channelValue: "slack", channelIdValue: "first-token", channelKeyValue: "second-token" }));
    expect(screen.getByRole("dialog", { name: "连接 Slack" })).toBeInTheDocument();
    expect(within(dialog).getByLabelText("Bot Token")).toHaveValue(" first-token ");
    expect(within(dialog).getByLabelText("App Token")).toHaveValue(" second-token ");
    expect(mock.error).toHaveBeenCalledWith({ content: "绑定失败" });
  });
  it("waits for disconnect and then closes even when the operation reports failure", async () => {
    mock.bound = ["slack"];
    let resolve: (value: boolean) => void = () => undefined;
    const request = new Promise<boolean>((done) => { resolve = done; });
    mock.remove.mockReturnValue(request);
    const user = userEvent.setup();
    render(<ChannelPanel {...{} as ChannelPanelProps} />);
    const trigger = within(card("slack")).getByRole("button", { name: "断开" });
    await user.click(trigger);
    await user.click(within(screen.getByRole("alertdialog", { name: "确认断开通道？" })).getByRole("button", { name: "确认断开" }));
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(mock.remove).toHaveBeenCalledWith("slack");
    await act(async () => { resolve(false); await request; });
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
    expect(mock.error).toHaveBeenCalledWith({ content: "断开失败" });
  });
  it("preserves the enterprise authorization and QR entry points", async () => {
    const user = userEvent.setup();
    render(<ChannelPanel {...{} as ChannelPanelProps} />);
    await user.click(within(card("wecom")).getByRole("button", { name: "+ 连接" }));
    await waitFor(() => expect(mock.wecom).toHaveBeenCalledTimes(1));
    await user.click(within(card("weixin")).getByRole("button", { name: "+ 连接" }));
    await waitFor(() => expect(mock.qr).toHaveBeenCalledTimes(1));
    expect(mock.configure).not.toHaveBeenCalled();
  });
});
