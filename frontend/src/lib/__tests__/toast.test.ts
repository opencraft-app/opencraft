import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { toast } from "@/lib/toast";

describe("toast", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runAllTimers();
    vi.useRealTimers();
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("复用 SDK message 容器，让后续提示纵向追加而不是重叠", () => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });

    toast.success("自动任务同步成功");

    const container = document.getElementById("_lh-message-container");
    expect(container).not.toBeNull();
    expect(container?.textContent).toContain("自动任务同步成功");

    const sdkMessage = document.createElement("div");
    sdkMessage.textContent = "模型切换成功";
    container?.appendChild(sdkMessage);

    expect(container?.children).toHaveLength(2);
    expect(container?.style.flexDirection).toBe("column");
    expect(container?.style.gap).toBe("8px");
    expect(container?.children[0]?.textContent).toContain("自动任务同步成功");
    expect(container?.children[1]?.textContent).toBe("模型切换成功");
  });

  it("默认展示 3 秒后自动移除", () => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });

    toast.success("已获取可用模型");

    expect(document.getElementById("_lh-message-container")).not.toBeNull();
    vi.advanceTimersByTime(2999);
    expect(document.getElementById("_lh-message-container")).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(document.getElementById("_lh-message-container")?.firstElementChild).toHaveStyle({ opacity: "0" });
    vi.advanceTimersByTime(200);
    expect(document.getElementById("_lh-message-container")).toBeNull();
  });
});
