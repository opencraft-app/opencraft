import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DrawSoulModal } from "@/pages/marketing/agent-buddy-draw-modal";

vi.mock("@/i18n/t", () => ({
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
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
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
