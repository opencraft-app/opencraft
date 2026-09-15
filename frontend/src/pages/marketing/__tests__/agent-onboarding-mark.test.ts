import { beforeEach, describe, expect, it } from "vitest";

import {
  clearPendingOnboarding,
  isPendingOnboarding,
  markPendingOnboarding,
  hasAgentSidebarLayout,
  shouldShowEarlyOnboarding,
} from "@/pages/marketing/agent-onboarding-mark";

const KEY = "lv-pending-onboarding-bots";

beforeEach(() => {
  window.sessionStorage.clear();
});

describe("markPendingOnboarding", () => {
  it("marks a bot as pending", () => {
    markPendingOnboarding("bot-1");
    expect(isPendingOnboarding("bot-1")).toBe(true);
  });

  it("keeps multiple bots independently", () => {
    markPendingOnboarding("bot-1");
    markPendingOnboarding("bot-2");
    expect(isPendingOnboarding("bot-1")).toBe(true);
    expect(isPendingOnboarding("bot-2")).toBe(true);
  });

  it("is idempotent", () => {
    markPendingOnboarding("bot-1");
    markPendingOnboarding("bot-1");
    expect(JSON.parse(window.sessionStorage.getItem(KEY)!)).toEqual(["bot-1"]);
  });

  it("ignores empty ids", () => {
    markPendingOnboarding("");
    expect(window.sessionStorage.getItem(KEY)).toBeNull();
  });
});

describe("isPendingOnboarding", () => {
  it("returns false for unmarked or undefined ids", () => {
    expect(isPendingOnboarding("bot-x")).toBe(false);
    expect(isPendingOnboarding(undefined)).toBe(false);
  });

  it("survives corrupted storage instead of throwing", () => {
    // 用户手改或格式变更时不能把引导判定搞崩
    window.sessionStorage.setItem(KEY, "not json");
    expect(isPendingOnboarding("bot-1")).toBe(false);

    window.sessionStorage.setItem(KEY, '{"not":"an array"}');
    expect(isPendingOnboarding("bot-1")).toBe(false);

    window.sessionStorage.setItem(KEY, '[1, 2, "bot-1"]');
    expect(isPendingOnboarding("bot-1")).toBe(true);
  });
});

describe("clearPendingOnboarding", () => {
  it("removes only the requested bot", () => {
    markPendingOnboarding("bot-1");
    markPendingOnboarding("bot-2");
    clearPendingOnboarding("bot-1");

    expect(isPendingOnboarding("bot-1")).toBe(false);
    expect(isPendingOnboarding("bot-2")).toBe(true);
  });

  it("is a no-op for unknown or empty ids", () => {
    markPendingOnboarding("bot-1");
    clearPendingOnboarding("bot-unknown");
    clearPendingOnboarding("");
    expect(isPendingOnboarding("bot-1")).toBe(true);
  });

  it("supports clearing both botId and instanceId forms", () => {
    // 打标可能用 instanceId，清理时两个都要能清掉
    markPendingOnboarding("ins-abc");
    markPendingOnboarding("bot-abc");
    clearPendingOnboarding("ins-abc");
    clearPendingOnboarding("bot-abc");
    expect(isPendingOnboarding("ins-abc")).toBe(false);
    expect(isPendingOnboarding("bot-abc")).toBe(false);
  });
});

describe("shouldShowEarlyOnboarding", () => {
  const base = {
    isCreating: true,
    isModifying: false,
    hasCreationError: false,
    onboardingJustFinished: false,
  };

  it("shows the form for the whole provisioning window", () => {
    expect(shouldShowEarlyOnboarding(base)).toBe(true);
  });

  it("does not need a botId, so the first coffee cup never leaks through", () => {
    // 创建入口是 setIsCreating(true) 紧接着 navigate(?creating=<botId>)，
    // 两步之间 botId 还没到位。若把 botId 当门槛，这一帧会漏回咖啡杯。
    expect(shouldShowEarlyOnboarding(base)).toBe(true);
  });

  it("does not need a pending-onboarding mark either", () => {
    // 打标发生在 URL 出现 ?creating= 之后的 effect 里，同样晚于 isCreating
    expect(shouldShowEarlyOnboarding(base)).toBe(true);
  });

  it("stays hidden when not creating", () => {
    expect(shouldShowEarlyOnboarding({ ...base, isCreating: false })).toBe(false);
  });

  it("yields to the error state so a failed instance stays visible", () => {
    expect(shouldShowEarlyOnboarding({ ...base, hasCreationError: true })).toBe(false);
  });

  it("yields to the upgrade state", () => {
    expect(shouldShowEarlyOnboarding({ ...base, isModifying: true })).toBe(false);
  });

  it("does not bounce back to the form right after finishing", () => {
    expect(shouldShowEarlyOnboarding({ ...base, onboardingJustFinished: true })).toBe(false);
  });
});

describe("hasAgentSidebarLayout", () => {
  it("applies the sidebar layout classes only when the sidebar renders", () => {
    expect(hasAgentSidebarLayout({ isCreating: false, hasActiveBot: true })).toBe(true);
  });

  it("drops them during creation so no empty 264px strip is left", () => {
    expect(hasAgentSidebarLayout({ isCreating: true, hasActiveBot: false })).toBe(false);
  });

  it("drops them while bots are still loading — the regression that showed a blank left column", () => {
    /*
     * 从首页 hero 进来时 URL 不带 ?creating=，所以 isCreating 初值是 false，
     * 要等 bots 拉完发现 provisioningBot 才转 true。这段窗口里 activeBot 也
     * 还没有（provisioning 实例被 visibleBots 过滤掉），侧边栏并不存在。
     * 若此时仍套用侧边栏 class，就会出现「左侧空白、刷新后才正常」。
     */
    expect(hasAgentSidebarLayout({ isCreating: false, hasActiveBot: false })).toBe(false);
  });

  it("drops them when creating even if an active bot exists", () => {
    expect(hasAgentSidebarLayout({ isCreating: true, hasActiveBot: true })).toBe(false);
  });
});
