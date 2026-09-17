import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  isCreditPackVisible,
  setCreditPackVisible,
} from "../credit-pack-visibility";

const STORAGE_KEY = "lightvela:credit-pack-visible";

beforeEach(() => {
  window.localStorage.clear();
  /* 清 window 内存标记，隔离用例 */
  delete (window as unknown as { __LIGHTVELA_SHOW_CREDIT_PACK__?: boolean }).__LIGHTVELA_SHOW_CREDIT_PACK__;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("credit-pack-visibility", () => {
  it("默认隐藏：无标记、无存储值时不可见", () => {
    expect(isCreditPackVisible()).toBe(false);
  });

  it("setCreditPackVisible(true) 后可见", () => {
    setCreditPackVisible(true);
    expect(isCreditPackVisible()).toBe(true);
  });

  it("状态写入 localStorage：模拟整页跳转（清 window 标记）后仍可见", () => {
    setCreditPackVisible(true);

    /* 模拟整页跳转：window 内存标记随新文档清空，localStorage 保留 */
    delete (window as unknown as { __LIGHTVELA_SHOW_CREDIT_PACK__?: boolean }).__LIGHTVELA_SHOW_CREDIT_PACK__;

    expect(isCreditPackVisible()).toBe(true);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("1");
  });

  it("setCreditPackVisible(false) 清除持久值：整页跳转后回到隐藏", () => {
    setCreditPackVisible(true);
    setCreditPackVisible(false);

    delete (window as unknown as { __LIGHTVELA_SHOW_CREDIT_PACK__?: boolean }).__LIGHTVELA_SHOW_CREDIT_PACK__;

    expect(isCreditPackVisible()).toBe(false);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("localStorage 不可用（隐私模式）时静默降级：window 标记仍生效", () => {
    const getter = vi.fn(() => {
      throw new Error("SecurityError");
    });
    Object.defineProperty(window, "localStorage", {
      get: getter,
      configurable: true,
    });

    try {
      /* 读挂了也不抛错 */
      expect(() => isCreditPackVisible()).not.toThrow();
      /* 写入靠 window 标记仍可用 */
      setCreditPackVisible(true);
      expect(isCreditPackVisible()).toBe(true);
    } finally {
      /* 还原真实 localStorage */
      vi.restoreAllMocks();
      delete (window as unknown as Record<string, unknown>).localStorage;
    }
  });
});
