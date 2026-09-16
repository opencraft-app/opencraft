import { useState } from "react";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryPanel } from "../agent-settings-page";
import type { HermesMemoryLimitTarget, HermesMemorySnapshot } from "../agent-memory";

const t = (text: string, options?: Record<string, unknown>) => text.replace(/\{\{(\w+)\}\}/g, (_, key: string) => String(options?.[key] ?? key));
const snapshot: HermesMemorySnapshot = {
  memoryCharLimit: 2400, userCharLimit: 1375, memoryChars: 1200, userChars: 600,
  memoryText: "Project context\nline two", userText: "User preference", usedFallbackLimits: false,
};
const props = {
  status: "ready" as const, snapshot, error: null, activeTab: "memory" as const,
  onTabChange: vi.fn(), onRefresh: vi.fn(), onSaveLimit: vi.fn(), onDraftChange: vi.fn(),
  savingLimitTarget: null, limitSaveError: null, t,
};
beforeEach(() => { vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} }); });
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

describe("Memory panel display and editor contract", () => {
  it("opens the refresh explanation in a Portal and invokes refresh only on activation", async () => {
    const refresh = vi.fn();
    const { container } = render(<MemoryPanel {...props} onRefresh={refresh} />);
    const user = userEvent.setup();
    const trigger = screen.getByRole("button", { name: "刷新" });
    await user.tab();
    expect(trigger).toHaveFocus();
    const tooltip = await screen.findByRole("tooltip");
    expect(container).not.toContainElement(tooltip);
    expect(tooltip).toHaveTextContent("刷新");
    expect(refresh).not.toHaveBeenCalled();
    await user.keyboard("{Enter}");
    expect(refresh).toHaveBeenCalledTimes(1);
  });
  it("uses keyboard tabs without refreshing and preserves multiline content", async () => {
    const refresh = vi.fn();
    function Harness() {
      const [activeTab, setActiveTab] = useState<"memory" | "user">("memory");
      return <MemoryPanel {...props} activeTab={activeTab} onTabChange={setActiveTab} onRefresh={refresh} />;
    }
    render(<Harness />);
    const user = userEvent.setup();
    const memory = screen.getByRole("tab", { name: "记忆" });
    expect(screen.getByText("Project context line two")).toHaveClass("whitespace-pre-wrap", "break-words");
    memory.focus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "用户画像" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveTextContent("User preference");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("labels and focuses the limit editor, cancels without writes, and restores the current limit", async () => {
    const save = vi.fn();
    render(<MemoryPanel {...props} onSaveLimit={save} />);
    const user = userEvent.setup();
    const card = screen.getByRole("region", { name: "记忆统计" });
    await user.click(within(card).getByRole("button", { name: "调整限额" }));
    const input = within(card).getByRole("spinbutton", { name: "记忆统计" });
    expect(input).toHaveFocus();
    await user.clear(input); await user.type(input, "2500");
    await user.keyboard("{Escape}");
    expect(within(card).queryByRole("spinbutton")).not.toBeInTheDocument();
    expect(within(card).getByRole("button", { name: "调整限额" })).toHaveFocus();
    expect(save).not.toHaveBeenCalled();
    await user.click(within(card).getByRole("button", { name: "调整限额" }));
    expect(within(card).getByRole("spinbutton")).toHaveValue(2400);
  });

  it("keeps a failed or partial save draft and disables both cards during a save", async () => {
    let finish!: (saved: boolean) => void;
    const save = vi.fn((_target: HermesMemoryLimitTarget, _value: number, _used: number) => new Promise<boolean>((resolve) => { finish = resolve; }));
    function Harness() {
      const [saving, setSaving] = useState<HermesMemoryLimitTarget | null>(null);
      const [error, setError] = useState<{ target: HermesMemoryLimitTarget; message: string } | null>(null);
      return <MemoryPanel {...props} savingLimitTarget={saving} limitSaveError={error} onSaveLimit={async (target, value, used) => {
        setSaving(target);
        const saved = await save(target, value, used);
        setSaving(null);
        if (!saved) setError({ target, message: "配置已保存，但后续步骤失败" });
        return saved;
      }} />;
    }
    render(<Harness />);
    const user = userEvent.setup();
    const card = screen.getByRole("region", { name: "记忆统计" });
    await user.click(within(card).getByRole("button", { name: "调整限额" }));
    const input = within(card).getByRole("spinbutton");
    await user.clear(input); await user.type(input, "2500");
    await user.click(within(card).getByRole("button", { name: "保存" }));
    expect(input).toBeDisabled();
    expect(within(card).getByRole("button", { name: "取消" })).toBeDisabled();
    expect(within(screen.getByRole("region", { name: "用户画像统计" })).getByRole("button", { name: "调整限额" })).toBeDisabled();
    expect(save).toHaveBeenCalledWith("memory", 2500, 1200);
    await act(async () => finish(false));
    await waitFor(() => expect(input).toBeEnabled());
    expect(input).toHaveValue(2500);
    expect(within(card).getByRole("alert")).toHaveTextContent("配置已保存，但后续步骤失败");
  });
});
