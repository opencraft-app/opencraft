import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import userEvent from "@testing-library/user-event";

import { DrawSoulModal } from "@/pages/marketing/agent-buddy-draw-modal";

vi.mock("@/i18n/t", () => ({
  // 组件里用它按 locale 格式化日期（Intl），mock 固定成 zh-CN
  useCurrentLocale: () => "zh-CN",
  useT: () => (text: string) => text,
}));

vi.mock("@/observability/datong-tracker", () => ({
  trackDatongClick: vi.fn(),
}));

const soul = {
  id: 1,
  slug: "direct-inject-soul",
  displayName: "直接注入人设",
  summary: "用于验证抽卡结果操作",
  remark: "",
  version: "1.0.0",
  createdAt: 1,
  updatedAt: 1,
};

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
};

async function revealSoul(): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: "开始抽卡" }));
  for (let step = 0; step < 20; step += 1) {
    await act(async () => vi.advanceTimersByTime(500));
    if (screen.queryByRole("button", { name: "添加，暂不注入" })) return;
  }
  throw new Error("Draw result was not revealed");
}

describe("DrawSoulModal", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  });
  it("opens as a named dialog and returns focus on Escape", async () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return <><button onClick={() => setOpen(true)}>Draw</button><DrawSoulModal open={open} souls={[soul]} onClose={() => setOpen(false)} onPick={vi.fn()} onInject={vi.fn()} /></>;
    }
    render(<Harness />);
    const user = userEvent.setup();
    const trigger = screen.getByRole("button", { name: "Draw" });
    await user.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "抽取人设" });
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("offers both actions and locks the modal while direct injection is pending", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const pending = deferred<boolean>();
    const onClose = vi.fn();
    const onPick = vi.fn();
    const onInject = vi.fn(() => pending.promise);

    render(
      <DrawSoulModal
        open
        souls={[soul]}
        onClose={onClose}
        onPick={onPick}
        onInject={onInject}
      />,
    );

    await revealSoul();

    const injectButton = screen.getByRole("button", { name: "注入此人设" });
    const addButton = screen.getByRole("button", { name: "添加，暂不注入" });
    const closeButton = screen.getByRole("button", { name: "关闭" });
    const backdrop = closeButton.parentElement?.parentElement;
    if (!backdrop) throw new Error("Draw modal backdrop not found");

    expect(addButton).toHaveStyle({ fontSize: "14px" });
    expect(injectButton).toHaveStyle({ fontSize: "14px" });
    expect(injectButton.nextElementSibling).toBe(addButton);

    fireEvent.click(injectButton);
    fireEvent.click(injectButton);
    fireEvent.click(addButton);
    fireEvent.click(closeButton);
    fireEvent.click(backdrop);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });

    expect(onInject).toHaveBeenCalledTimes(1);
    expect(onInject).toHaveBeenCalledWith(soul);
    expect(onPick).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "注入中…" })).toBeDisabled();
    expect(addButton).toBeDisabled();
    expect(closeButton).toBeDisabled();

    await act(async () => pending.resolve(false));

    expect(screen.getByRole("button", { name: "注入此人设" })).toBeEnabled();
    expect(addButton).toBeEnabled();
    expect(closeButton).toBeEnabled();
  });
});
