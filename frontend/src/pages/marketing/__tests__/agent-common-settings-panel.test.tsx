import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BotRepository } from "@/repositories/types";

import { AgentCommonSettingsPanel } from "../agent-common-settings-panel";
import type { HermesCommonSettingsSnapshot } from "../agent-common-settings";
import type { HermesCommonSettingsResetResult } from "../agent-common-settings-reset";
import type { HermesCommonSettingSaveResult } from "../agent-common-settings-save";

const toastMocks = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@/lib/toast", () => ({ toast: toastMocks }));

const baseSnapshot = (patch?: Partial<HermesCommonSettingsSnapshot>): HermesCommonSettingsSnapshot => ({
  values: {
    persistentMemory: true,
    userProfile: true,
    autoCompression: true,
    compressionThreshold: 0.5,
    compressionTarget: 0.2,
    protectedRecentMessages: 20,
  },
  defaultedKeys: [],
  unsupportedKeys: [],
  ...patch,
});

const bots = {} as BotRepository;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AgentCommonSettingsPanel", () => {
  it("renders six flat rows and saves a switch only after confirmation", async () => {
    const user = userEvent.setup();
    const saveSetting = vi.fn().mockImplementation(async ({ key, value }) => ({
      status: "success",
      snapshot: baseSnapshot({ values: { ...baseSnapshot().values, [key]: value } }),
    } satisfies HermesCommonSettingSaveResult));

    render(
      <AgentCommonSettingsPanel
        botId="bot-a"
        botStatus="running"
        bots={bots}
        getGatewayRestartCommand={async () => "restart"}
        loadSettings={async () => baseSnapshot()}
        saveSetting={saveSetting}
      />,
    );

    const memorySwitch = await screen.findByRole("switch", { name: "长期记忆" });
    expect(screen.getAllByTestId("common-setting-row")).toHaveLength(6);
    await user.click(memorySwitch);

    expect(saveSetting).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "确认关闭「长期记忆」？" })).toBeTruthy();
    expect(screen.getByText("关闭后，Agent 将停止读取和更新 MEMORY.md，已有内容不会删除。")).toBeTruthy();
    const confirmButton = screen.getByRole("button", { name: "确认关闭" });
    expect(confirmButton.className).toContain("bg-[var(--text-primary)]");
    expect(confirmButton.className).not.toContain("bg-[#0052D9]");
    await user.click(screen.getByRole("button", { name: "取消" }));
    expect(saveSetting).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();

    await user.click(memorySwitch);
    await user.click(screen.getByRole("button", { name: "确认关闭" }));

    await waitFor(() => expect(saveSetting).toHaveBeenCalledWith(expect.objectContaining({
      botId: "bot-a",
      key: "persistentMemory",
      value: false,
    })));
    await waitFor(() => expect(toastMocks.success).toHaveBeenCalledWith("已保存"));
    expect(screen.queryByText("已保存")).toBeNull();
  });

  it.each([
    ["长期记忆", "persistentMemory", false, "开启", "开启后，Agent 将在后续会话中读取和更新 MEMORY.md。"],
    ["用户画像", "userProfile", true, "关闭", "关闭后，Agent 将停止使用 USER.md 维护用户偏好，已有内容不会删除。"],
    ["用户画像", "userProfile", false, "开启", "开启后，Agent 将使用 USER.md 维护语言、沟通方式和协作偏好。"],
    ["自动压缩", "autoCompression", true, "关闭", "关闭后，长对话不会自动总结较早内容，可能更快达到上下文限制；已有压缩参数不会删除。"],
    ["自动压缩", "autoCompression", false, "开启", "开启后，长对话接近上下文限制时会自动总结较早内容，并继续使用已有压缩参数。"],
  ] as const)("requires confirmation before changing %s", async (label, key, currentValue, action, description) => {
    const user = userEvent.setup();
    const saveSetting = vi.fn().mockImplementation(async ({ value }) => ({
      status: "success",
      snapshot: baseSnapshot({
        values: { ...baseSnapshot().values, [key]: value },
      }),
    } satisfies HermesCommonSettingSaveResult));

    render(
      <AgentCommonSettingsPanel
        botId="bot-a"
        botStatus="running"
        bots={bots}
        getGatewayRestartCommand={async () => "restart"}
        loadSettings={async () => baseSnapshot({
          values: { ...baseSnapshot().values, [key]: currentValue },
        })}
        saveSetting={saveSetting}
      />,
    );

    await user.click(await screen.findByRole("switch", { name: label }));
    expect(saveSetting).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: `确认${action}「${label}」？` })).toBeTruthy();
    expect(screen.getByText(description)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: `确认${action}` }));
    await waitFor(() => expect(saveSetting).toHaveBeenCalledWith(expect.objectContaining({
      key,
      value: !currentValue,
    })));
  });

  it("separates setting rows with whitespace instead of divider lines", async () => {
    render(
      <AgentCommonSettingsPanel
        botId="bot-a"
        botStatus="running"
        bots={bots}
        getGatewayRestartCommand={async () => "restart"}
        loadSettings={async () => baseSnapshot()}
        saveSetting={vi.fn()}
      />,
    );

    const rows = await screen.findAllByTestId("common-setting-row");
    expect(rows[0]!.parentElement).not.toHaveClass("divide-y", "border-y");
  });

  it("gives switch descriptions the remaining desktop width without narrowing numeric controls", async () => {
    render(
      <AgentCommonSettingsPanel
        botId="bot-a"
        botStatus="running"
        bots={bots}
        getGatewayRestartCommand={async () => "restart"}
        loadSettings={async () => baseSnapshot()}
        saveSetting={vi.fn()}
      />,
    );

    const rows = await screen.findAllByTestId("common-setting-row");
    for (const row of rows.slice(0, 3)) {
      expect(row).toHaveClass("sm:grid-cols-[minmax(0,1fr)_auto]");
    }
    for (const row of rows.slice(3)) {
      expect(row).toHaveClass("sm:grid-cols-[minmax(0,1fr)_17rem]");
    }
  });

  it("aligns memory setting descriptions with the memory page", async () => {
    render(
      <AgentCommonSettingsPanel
        botId="bot-a"
        botStatus="running"
        bots={bots}
        getGatewayRestartCommand={async () => "restart"}
        loadSettings={async () => baseSnapshot()}
        saveSetting={vi.fn()}
      />,
    );

    expect(await screen.findByText("让 Agent 在会话中读取和更新长期记忆文件 MEMORY.md。")).toBeTruthy();
    expect(screen.getByText("让 Agent 使用 USER.md 按需记录和更新你的偏好、沟通方式与使用习惯。")).toBeTruthy();
    expect(screen.queryByText(/关闭不会删除已有内容/)).toBeNull();
    const memoryLinks = screen.getAllByRole("link", { name: "查看内容" });
    expect(memoryLinks).toHaveLength(2);
    for (const link of memoryLinks) {
      expect(link).toHaveAttribute("href", "/agents/memory");
      expect(link).not.toHaveAttribute("target");
    }
    expect(screen.queryByText("管理常用的记忆与上下文行为。修改后会自动重启 Gateway 并验证结果。")).toBeNull();
  });

  it("uses theme tokens for product-blue actions and focus rings", async () => {
    render(
      <AgentCommonSettingsPanel
        botId="bot-a"
        botStatus="running"
        bots={bots}
        getGatewayRestartCommand={async () => "restart"}
        loadSettings={async () => baseSnapshot()}
        saveSetting={vi.fn()}
      />,
    );

    const memorySwitch = await screen.findByRole("switch", { name: "长期记忆" });
    expect(memorySwitch).toHaveClass("bg-[var(--lw-accent)]");

    const memoryLink = screen.getAllByRole("link", { name: "查看内容" })[0]!;
    expect(memoryLink).toHaveClass("text-[var(--lw-accent)]", "focus-visible:ring-[var(--ring)]");

    const editButton = screen.getByRole("button", { name: "编辑压缩触发阈值" });
    expect(editButton).toHaveClass("focus-visible:ring-[var(--ring)]");
    expect(document.body.innerHTML).not.toContain("#0052D9");
    expect(document.body.innerHTML).not.toContain("#003cab");
  });

  it("separates memory and context groups with one divider without adding row dividers", async () => {
    render(
      <AgentCommonSettingsPanel
        botId="bot-a"
        botStatus="running"
        bots={bots}
        getGatewayRestartCommand={async () => "restart"}
        loadSettings={async () => baseSnapshot()}
        saveSetting={vi.fn()}
      />,
    );

    const groups = await screen.findAllByTestId("common-setting-group");
    expect(groups).toHaveLength(2);

    expect(within(groups[0]!).getByRole("heading", { name: "记忆" })).toBeTruthy();
    expect(within(groups[0]!).getByText("管理跨会话保留的长期信息与用户偏好。")).toBeTruthy();
    expect(within(groups[0]!).getAllByTestId("common-setting-row")).toHaveLength(2);
    expect(within(groups[0]!).getByRole("switch", { name: "长期记忆" })).toBeTruthy();
    expect(within(groups[0]!).getByRole("switch", { name: "用户画像" })).toBeTruthy();

    expect(within(groups[1]!).getByRole("heading", { name: "上下文管理" })).toBeTruthy();
    expect(within(groups[1]!).getByText("管理长对话的上下文处理与压缩设置。")).toBeTruthy();
    expect(screen.queryByText("管理长对话压缩的触发时机与原文保留范围。")).toBeNull();
    expect(within(groups[1]!).getByText("压缩后保留多少近期对话原文；数值越大，保留越多，可填写 0.1 到 0.8。")).toBeTruthy();
    expect(screen.queryByText("压缩时为近期原文保留的 Token 比例，可填写 0.1 到 0.8。")).toBeNull();
    expect(within(groups[1]!).getAllByTestId("common-setting-row")).toHaveLength(4);

    expect(groups[0]!).not.toHaveClass("border-t");
    expect(groups[1]!).toHaveClass("border-t", "border-black/[0.08]", "pt-10");

    for (const group of groups) {
      expect(group).not.toHaveClass("border", "divide-y", "rounded-md", "shadow");
    }
  });

  it("places one reset button beside each group title and disables only groups already using defaults", async () => {
    render(
      <AgentCommonSettingsPanel
        botId="bot-a"
        botStatus="running"
        bots={bots}
        getGatewayRestartCommand={async () => "restart"}
        loadSettings={async () => baseSnapshot({
          defaultedKeys: ["persistentMemory", "userProfile"],
        })}
        saveSetting={vi.fn()}
        resetSettings={vi.fn()}
      />,
    );

    const groups = await screen.findAllByTestId("common-setting-group");
    const memoryReset = within(groups[0]!).getByRole("button", { name: "恢复默认" });
    const contextReset = within(groups[1]!).getByRole("button", { name: "恢复默认" });

    expect(memoryReset).toBeDisabled();
    expect(contextReset).toBeEnabled();
    for (const resetButton of [memoryReset, contextReset]) {
      expect(resetButton).toHaveClass(
        "rounded-md",
        "border",
        "border-black/10",
        "px-2",
        "py-1",
        "text-[12px]",
        "font-medium",
        "text-black/70",
        "transition",
        "hover:bg-black/[0.04]",
      );
      expect(resetButton).not.toHaveClass(
        "h-7",
        "bg-white",
        "px-2.5",
        "shadow-sm",
        "hover:bg-black/[0.03]",
      );
    }
    expect(within(groups[0]!).getByRole("heading", { name: "记忆" }).parentElement).toContainElement(memoryReset);
    expect(within(groups[1]!).getByRole("heading", { name: "上下文管理" }).parentElement).toContainElement(contextReset);
  });

  it("confirms and restores only the selected group with a red destructive action", async () => {
    const user = userEvent.setup();
    const initial = baseSnapshot({
      values: {
        ...baseSnapshot().values,
        compressionThreshold: 0.8,
        compressionTarget: 0.3,
        protectedRecentMessages: 33,
      },
    });
    const resetSettings = vi.fn().mockResolvedValue({
      status: "success",
      snapshot: baseSnapshot({
        values: initial.values,
        defaultedKeys: ["persistentMemory", "userProfile"],
      }),
    } satisfies HermesCommonSettingsResetResult);

    render(
      <AgentCommonSettingsPanel
        botId="bot-a"
        botStatus="running"
        bots={bots}
        getGatewayRestartCommand={async () => "restart"}
        loadSettings={async () => initial}
        saveSetting={vi.fn()}
        resetSettings={resetSettings}
      />,
    );

    const groups = await screen.findAllByTestId("common-setting-group");
    await user.click(within(groups[0]!).getByRole("button", { name: "恢复默认" }));
    expect(screen.getByRole("heading", { name: "确认恢复「记忆」设置？" })).toBeTruthy();
    expect(screen.getByText("将重置「记忆」分组下的自定义配置，重新恢复为 Hermes Agent 默认值。")).toBeTruthy();
    expect(screen.queryByText("将移除该分组的自定义配置，重新使用 Hermes 默认值。")).toBeNull();
    const confirmButton = screen.getByRole("button", { name: "确认恢复" });
    expect(confirmButton).toHaveClass("bg-red-600", "hover:bg-red-700");
    await user.click(screen.getByRole("button", { name: "取消" }));
    expect(resetSettings).not.toHaveBeenCalled();

    await user.click(within(groups[0]!).getByRole("button", { name: "恢复默认" }));
    await user.click(screen.getByRole("button", { name: "确认恢复" }));

    await waitFor(() => expect(resetSettings).toHaveBeenCalledWith(expect.objectContaining({
      botId: "bot-a",
      group: "memory",
      snapshot: initial,
    })));
    await waitFor(() => expect(toastMocks.success).toHaveBeenCalledWith("已恢复默认"));
    expect(screen.getByTestId("common-setting-value-compressionThreshold")).toHaveTextContent("0.8");
    expect(screen.getByTestId("common-setting-value-compressionTarget")).toHaveTextContent("0.3");
    expect(screen.getByTestId("common-setting-value-protectedRecentMessages")).toHaveTextContent("33");
  });

  it("passes the context group independently and reports failed or partial resets with Toast", async () => {
    const user = userEvent.setup();
    const resetSettings = vi.fn()
      .mockResolvedValueOnce({ status: "failed", error: new Error("permission denied") })
      .mockResolvedValueOnce({ status: "partial", error: new Error("restart failed") });

    render(
      <AgentCommonSettingsPanel
        botId="bot-a"
        botStatus="running"
        bots={bots}
        getGatewayRestartCommand={async () => "restart"}
        loadSettings={async () => baseSnapshot()}
        saveSetting={vi.fn()}
        resetSettings={resetSettings}
      />,
    );

    const groups = await screen.findAllByTestId("common-setting-group");
    const contextReset = within(groups[1]!).getByRole("button", { name: "恢复默认" });
    await user.click(contextReset);
    expect(screen.getByRole("heading", { name: "确认恢复「上下文管理」设置？" })).toBeTruthy();
    expect(screen.getByText("将重置「上下文管理」分组下的自定义配置，重新恢复为 Hermes Agent 默认值。")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "确认恢复" }));
    await waitFor(() => expect(resetSettings).toHaveBeenLastCalledWith(expect.objectContaining({ group: "context" })));
    await waitFor(() => expect(toastMocks.error).toHaveBeenCalledWith("恢复失败：permission denied"));

    await user.click(contextReset);
    await user.click(screen.getByRole("button", { name: "确认恢复" }));
    await waitFor(() => expect(toastMocks.error).toHaveBeenCalledWith("部分配置已恢复，但后续操作失败，请刷新确认。"));
  });

  it("disables every setting action while a reset is pending or a number is being edited", async () => {
    const user = userEvent.setup();
    let resolveReset: ((result: HermesCommonSettingsResetResult) => void) | undefined;
    const resetSettings = vi.fn().mockImplementation(() => new Promise<HermesCommonSettingsResetResult>((resolve) => {
      resolveReset = resolve;
    }));

    render(
      <AgentCommonSettingsPanel
        botId="bot-a"
        botStatus="running"
        bots={bots}
        getGatewayRestartCommand={async () => "restart"}
        loadSettings={async () => baseSnapshot()}
        saveSetting={vi.fn()}
        resetSettings={resetSettings}
      />,
    );

    const groups = await screen.findAllByTestId("common-setting-group");
    const resetButtons = screen.getAllByRole("button", { name: "恢复默认" });
    await user.click(within(groups[1]!).getByRole("button", { name: "编辑压缩触发阈值" }));
    expect(resetButtons[0]!).toBeDisabled();
    expect(resetButtons[1]!).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "取消编辑压缩触发阈值" }));

    await user.click(resetButtons[0]!);
    await user.click(screen.getByRole("button", { name: "确认恢复" }));
    await waitFor(() => expect(resetSettings).toHaveBeenCalledTimes(1));
    for (const button of screen.getAllByRole("button", { name: "恢复默认" })) expect(button).toBeDisabled();
    for (const control of screen.getAllByRole("switch")) expect(control).toBeDisabled();
    expect(screen.getByRole("button", { name: "编辑压缩触发阈值" })).toBeDisabled();

    resolveReset?.({ status: "success", snapshot: baseSnapshot({ defaultedKeys: ["persistentMemory", "userProfile"] }) });
    await waitFor(() => expect(toastMocks.success).toHaveBeenCalledWith("已恢复默认"));
  });

  it("edits a numeric value explicitly and saves only from the save action", async () => {
    const user = userEvent.setup();
    const saveSetting = vi.fn().mockResolvedValue({
      status: "success",
      snapshot: baseSnapshot({
        values: { ...baseSnapshot().values, compressionThreshold: 0.65 },
      }),
    } satisfies HermesCommonSettingSaveResult);
    render(
      <AgentCommonSettingsPanel
        botId="bot-a"
        botStatus="running"
        bots={bots}
        getGatewayRestartCommand={async () => "restart"}
        loadSettings={async () => baseSnapshot()}
        saveSetting={saveSetting}
      />,
    );

    const editButton = await screen.findByRole("button", { name: "编辑压缩触发阈值" });
    expect(screen.queryByRole("spinbutton", { name: "压缩触发阈值" })).toBeNull();
    const value = screen.getByTestId("common-setting-value-compressionThreshold");
    expect(editButton.parentElement).toHaveClass("group/value", "relative", "pt-8");
    expect(value.parentElement).toHaveClass("h-10", "rounded-md", "border", "bg-white");
    expect(editButton).toHaveClass(
      "absolute",
      "right-2",
      "top-0",
      "opacity-100",
      "sm:opacity-0",
      "sm:group-hover/value:opacity-100",
    );
    expect(editButton).not.toHaveClass("-translate-y-1/2");

    await user.click(editButton);
    const input = screen.getByRole("spinbutton", { name: "压缩触发阈值" });
    const saveButton = screen.getByRole("button", { name: "保存压缩触发阈值" });
    expect(saveButton).toBeDisabled();
    await user.clear(input);
    await user.type(input, "0.65");
    expect(saveButton).toBeEnabled();
    expect(saveSetting).not.toHaveBeenCalled();
    fireEvent.blur(input);
    expect(saveSetting).not.toHaveBeenCalled();
    await user.click(saveButton);

    await waitFor(() => expect(saveSetting).toHaveBeenCalledWith(expect.objectContaining({
      key: "compressionThreshold",
      value: 0.65,
    })));
    await waitFor(() => expect(screen.queryByRole("spinbutton", { name: "压缩触发阈值" })).toBeNull());
    expect(screen.getByTestId("common-setting-value-compressionThreshold")).toHaveTextContent("0.65");
    expect(toastMocks.success).toHaveBeenCalledWith("已保存");
    expect(screen.queryByText("已保存")).toBeNull();
  });

  it("cancels numeric edits with the cancel action or Escape and saves with Enter", async () => {
    const user = userEvent.setup();
    const saveSetting = vi.fn().mockResolvedValue({ status: "success", snapshot: baseSnapshot() });
    render(
      <AgentCommonSettingsPanel
        botId="bot-a"
        botStatus="running"
        bots={bots}
        getGatewayRestartCommand={async () => "restart"}
        loadSettings={async () => baseSnapshot()}
        saveSetting={saveSetting}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "编辑压缩保留比例" }));
    const input = screen.getByRole("spinbutton", { name: "压缩保留比例" });
    await user.clear(input);
    await user.type(input, "0.3");
    await user.click(screen.getByRole("button", { name: "取消编辑压缩保留比例" }));
    expect(saveSetting).not.toHaveBeenCalled();
    expect(screen.queryByRole("spinbutton", { name: "压缩保留比例" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "编辑压缩保留比例" }));
    const escapeInput = screen.getByRole("spinbutton", { name: "压缩保留比例" });
    await user.clear(escapeInput);
    await user.type(escapeInput, "0.3{Escape}");
    expect(screen.queryByRole("spinbutton", { name: "压缩保留比例" })).toBeNull();
    expect(saveSetting).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "编辑压缩保留比例" }));
    const enterInput = screen.getByRole("spinbutton", { name: "压缩保留比例" });
    await user.clear(enterInput);
    await user.type(enterInput, "0.3{Enter}");
    await waitFor(() => expect(saveSetting).toHaveBeenCalledWith(expect.objectContaining({
      key: "compressionTarget",
      value: 0.3,
    })));
  });

  it("exits numeric edit mode when Enter normalizes to the current value", async () => {
    const user = userEvent.setup();
    const saveSetting = vi.fn();
    render(
      <AgentCommonSettingsPanel
        botId="bot-a"
        botStatus="running"
        bots={bots}
        getGatewayRestartCommand={async () => "restart"}
        loadSettings={async () => baseSnapshot()}
        saveSetting={saveSetting}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "编辑保留最近消息" }));
    const input = screen.getByRole("spinbutton", { name: "保留最近消息" });
    await user.clear(input);
    await user.type(input, "020{Enter}");

    expect(saveSetting).not.toHaveBeenCalled();
    expect(screen.queryByRole("spinbutton", { name: "保留最近消息" })).toBeNull();
    expect(screen.getByTestId("common-setting-value-protectedRecentMessages")).toHaveTextContent("20");
  });

  it("keeps invalid numeric input in edit mode and prevents saving", async () => {
    const user = userEvent.setup();
    const saveSetting = vi.fn();
    render(
      <AgentCommonSettingsPanel
        botId="bot-a"
        botStatus="running"
        bots={bots}
        getGatewayRestartCommand={async () => "restart"}
        loadSettings={async () => baseSnapshot()}
        saveSetting={saveSetting}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "编辑压缩触发阈值" }));
    const input = screen.getByRole("spinbutton", { name: "压缩触发阈值" });
    await user.clear(input);
    await user.type(input, "2");
    await user.click(screen.getByRole("button", { name: "保存压缩触发阈值" }));

    expect(saveSetting).not.toHaveBeenCalled();
    expect(screen.getByRole("spinbutton", { name: "压缩触发阈值" })).toHaveValue(2);
    expect(screen.getByRole("alert")).toHaveTextContent("输入值超出允许范围");
  });

  it("keeps compression values visible but disables editing when auto compression is off", async () => {
    render(
      <AgentCommonSettingsPanel
        botId="bot-a"
        botStatus="running"
        bots={bots}
        getGatewayRestartCommand={async () => "restart"}
        loadSettings={async () => baseSnapshot({
          values: { ...baseSnapshot().values, autoCompression: false },
        })}
        saveSetting={vi.fn()}
      />,
    );

    expect(await screen.findByRole("button", { name: "编辑压缩触发阈值" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "编辑压缩保留比例" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "编辑保留最近消息" })).toBeDisabled();
    expect(screen.queryByRole("spinbutton")).toBeNull();
    expect(screen.getByTestId("common-setting-value-compressionThreshold")).toHaveTextContent("0.5");
  });

  it("keeps defaulted values visually quiet and does not present fallback values for unsupported settings", async () => {
    render(
      <AgentCommonSettingsPanel
        botId="bot-a"
        botStatus="running"
        bots={bots}
        getGatewayRestartCommand={async () => "restart"}
        loadSettings={async () => baseSnapshot({
          defaultedKeys: ["compressionThreshold"],
          unsupportedKeys: ["userProfile", "compressionThreshold"],
        })}
        saveSetting={vi.fn()}
      />,
    );

    await screen.findByRole("heading", { name: "压缩触发阈值" });
    expect(screen.queryByText("沿用系统默认")).toBeNull();
    expect(screen.queryByRole("switch", { name: "用户画像" })).toBeNull();
    expect(screen.queryByRole("button", { name: "编辑压缩触发阈值" })).toBeNull();
    expect(screen.getByTestId("common-setting-unsupported-userProfile")).toHaveTextContent("—");
    expect(screen.getByTestId("common-setting-unsupported-compressionThreshold")).toHaveTextContent("—");
    expect(screen.getAllByText("当前 Agent 版本不支持")).toHaveLength(2);
  });

  it("allows a defaulted setting to be saved without showing a default hint", async () => {
    const user = userEvent.setup();
    const saveSetting = vi.fn().mockResolvedValue({
      status: "success",
      snapshot: baseSnapshot(),
    } satisfies HermesCommonSettingSaveResult);

    render(
      <AgentCommonSettingsPanel
        botId="bot-a"
        botStatus="running"
        bots={bots}
        getGatewayRestartCommand={async () => "restart"}
        loadSettings={async () => baseSnapshot({ defaultedKeys: ["persistentMemory"] })}
        saveSetting={saveSetting}
      />,
    );

    await screen.findByRole("switch", { name: "长期记忆" });
    expect(screen.queryByText("沿用系统默认")).toBeNull();
    await user.click(screen.getByRole("switch", { name: "长期记忆" }));
    await user.click(screen.getByRole("button", { name: "确认关闭" }));

    await waitFor(() => expect(saveSetting).toHaveBeenCalledTimes(1));
  });

  it("prevents concurrent Gateway restarts when controls are clicked rapidly", async () => {
    const user = userEvent.setup();
    let resolveSave: ((result: HermesCommonSettingSaveResult) => void) | undefined;
    const saveSetting = vi.fn().mockImplementation(() => new Promise<HermesCommonSettingSaveResult>((resolve) => {
      resolveSave = resolve;
    }));
    render(
      <AgentCommonSettingsPanel
        botId="bot-a"
        botStatus="running"
        bots={bots}
        getGatewayRestartCommand={async () => "restart"}
        loadSettings={async () => baseSnapshot()}
        saveSetting={saveSetting}
      />,
    );

    const memorySwitch = await screen.findByRole("switch", { name: "长期记忆" });
    const profileSwitch = screen.getByRole("switch", { name: "用户画像" });
    await user.click(memorySwitch);
    await user.click(screen.getByRole("button", { name: "确认关闭" }));

    expect(memorySwitch).toBeDisabled();
    expect(profileSwitch).toBeDisabled();
    fireEvent.click(profileSwitch);
    expect(screen.queryByRole("heading", { name: "确认关闭「用户画像」？" })).toBeNull();

    expect(saveSetting).toHaveBeenCalledTimes(1);
    resolveSave?.({ status: "success", snapshot: baseSnapshot() });
    await waitFor(() => expect(toastMocks.success).toHaveBeenCalledWith("已保存"));
    expect(screen.queryByText("已保存")).toBeNull();
  });

  it("clears in-flight save state when switching to another Agent", async () => {
    const user = userEvent.setup();
    const saveSetting = vi.fn().mockImplementation(() => new Promise<HermesCommonSettingSaveResult>(() => {}));
    const loadSettings = vi.fn().mockResolvedValue(baseSnapshot());
    const { rerender } = render(
      <AgentCommonSettingsPanel
        botId="bot-a"
        botStatus="running"
        bots={bots}
        getGatewayRestartCommand={async () => "restart"}
        loadSettings={loadSettings}
        saveSetting={saveSetting}
      />,
    );

    await user.click(await screen.findByRole("switch", { name: "长期记忆" }));
    await user.click(screen.getByRole("button", { name: "确认关闭" }));
    await waitFor(() => expect(saveSetting).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("switch", { name: "用户画像" })).toBeDisabled();

    rerender(
      <AgentCommonSettingsPanel
        botId="bot-b"
        botStatus="running"
        bots={bots}
        getGatewayRestartCommand={async () => "restart"}
        loadSettings={loadSettings}
        saveSetting={saveSetting}
      />,
    );

    await waitFor(() => expect(loadSettings).toHaveBeenCalledWith(bots, "bot-b"));
    expect(await screen.findByRole("switch", { name: "用户画像" })).toBeEnabled();
    expect(screen.queryByText("保存中…")).toBeNull();
  });
});
