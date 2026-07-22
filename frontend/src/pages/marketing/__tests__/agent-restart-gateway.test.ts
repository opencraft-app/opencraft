import { describe, expect, it } from "vitest";

import {
  getRestartBlockReason,
  isActiveBotRestarting,
  getActiveBotRestartError,
  buildRestartErrorMessage,
  setErrorForBot,
  clearErrorForBot,
  type RestartableBot,
  type RestartErrors,
} from "../agent-restart-gateway";

const bot = (id: string, status: RestartableBot["status"] = "running"): RestartableBot => ({ id, status });

describe("getRestartBlockReason", () => {
  it("returns null when bot is running and not already restarting", () => {
    expect(getRestartBlockReason(bot("a"), new Set())).toBeNull();
  });

  it("blocks when no active bot", () => {
    expect(getRestartBlockReason(undefined, new Set())).toBe("no_active_bot");
  });

  it("blocks when bot is already restarting", () => {
    expect(getRestartBlockReason(bot("a"), new Set(["a"]))).toBe("already_restarting");
  });

  it("blocks when bot is not running", () => {
    expect(getRestartBlockReason(bot("a", "paused"), new Set())).toBe("not_running");
    expect(getRestartBlockReason(bot("a", "provisioning"), new Set())).toBe("not_running");
    expect(getRestartBlockReason(bot("a", "failed"), new Set())).toBe("not_running");
  });

  it("allows restarting a different bot while another is in progress", () => {
    expect(getRestartBlockReason(bot("b"), new Set(["a"]))).toBeNull();
  });
});

describe("isActiveBotRestarting", () => {
  it("returns true when active bot is in the restarting set", () => {
    expect(isActiveBotRestarting(bot("a"), new Set(["a"]))).toBe(true);
  });

  it("returns false when active bot is not in the set", () => {
    expect(isActiveBotRestarting(bot("a"), new Set(["b"]))).toBe(false);
  });

  it("returns false when no active bot", () => {
    expect(isActiveBotRestarting(undefined, new Set(["a"]))).toBe(false);
  });

  it("supports multiple bots restarting simultaneously", () => {
    const set = new Set(["a", "b"]);
    expect(isActiveBotRestarting(bot("a"), set)).toBe(true);
    expect(isActiveBotRestarting(bot("b"), set)).toBe(true);
    expect(isActiveBotRestarting(bot("c"), set)).toBe(false);
  });
});

describe("getActiveBotRestartError", () => {
  it("returns message when error exists for active bot", () => {
    const errors: RestartErrors = new Map([["a", "重启失败：timeout"]]);
    expect(getActiveBotRestartError(bot("a"), errors)).toBe("重启失败：timeout");
  });

  it("returns null when error belongs to a different bot", () => {
    const errors: RestartErrors = new Map([["a", "重启失败：timeout"]]);
    expect(getActiveBotRestartError(bot("b"), errors)).toBeNull();
  });

  it("returns null when there are no errors", () => {
    expect(getActiveBotRestartError(bot("a"), new Map())).toBeNull();
  });

  it("returns null when no active bot", () => {
    const errors: RestartErrors = new Map([["a", "重启失败"]]);
    expect(getActiveBotRestartError(undefined, errors)).toBeNull();
  });

  it("each bot gets its own error independently", () => {
    const errors: RestartErrors = new Map([
      ["a", "失败A"],
      ["b", "失败B"],
    ]);
    expect(getActiveBotRestartError(bot("a"), errors)).toBe("失败A");
    expect(getActiveBotRestartError(bot("b"), errors)).toBe("失败B");
    expect(getActiveBotRestartError(bot("c"), errors)).toBeNull();
  });
});

describe("buildRestartErrorMessage", () => {
  it("returns null on SUCCESS", () => {
    expect(buildRestartErrorMessage({ status: "SUCCESS", exitCode: 0, output: "ok" })).toBeNull();
  });

  it("returns null on Succeeded with exit code 0", () => {
    expect(buildRestartErrorMessage({ status: "Succeeded", exitCode: 0, output: "ok" })).toBeNull();
  });

  it("returns error when status succeeds but exit code is non-zero", () => {
    expect(buildRestartErrorMessage({ status: "SUCCESS", exitCode: 1, output: "restart failed" })).toBe(
      "重启失败：restart failed",
    );
  });

  it("returns error with output on failure", () => {
    expect(buildRestartErrorMessage({ status: "FAILED", exitCode: 1, output: "signal 9" })).toBe("重启失败：signal 9");
  });

  it("uses fallback message when output is empty", () => {
    expect(buildRestartErrorMessage({ status: "FAILED", exitCode: 1, output: "" })).toBe("重启失败：未知错误");
  });

  it("uses fallback message when output is undefined", () => {
    expect(buildRestartErrorMessage({ status: "TIMEOUT", exitCode: 124 })).toBe("重启失败：未知错误");
  });
});

describe("setErrorForBot", () => {
  it("adds error for a bot", () => {
    const errors = setErrorForBot(new Map(), "a", "失败");
    expect(errors.get("a")).toBe("失败");
  });

  it("overwrites previous error for the same bot", () => {
    const errors = setErrorForBot(new Map([["a", "旧错误"]]), "a", "新错误");
    expect(errors.get("a")).toBe("新错误");
  });

  it("preserves other bots errors", () => {
    const initial: RestartErrors = new Map([["b", "B的错误"]]);
    const errors = setErrorForBot(initial, "a", "A的错误");
    expect(errors.get("a")).toBe("A的错误");
    expect(errors.get("b")).toBe("B的错误");
  });
});

describe("clearErrorForBot", () => {
  it("clears error for the target bot", () => {
    const initial: RestartErrors = new Map([["a", "失败"]]);
    const errors = clearErrorForBot(initial, "a");
    expect(errors.has("a")).toBe(false);
  });

  it("preserves other bots errors", () => {
    const initial: RestartErrors = new Map([["a", "失败A"], ["b", "失败B"]]);
    const errors = clearErrorForBot(initial, "a");
    expect(errors.has("a")).toBe(false);
    expect(errors.get("b")).toBe("失败B");
  });

  it("returns same map when bot has no error", () => {
    const initial: RestartErrors = new Map([["b", "失败B"]]);
    const errors = clearErrorForBot(initial, "a");
    expect(errors).toBe(initial); // same reference — no unnecessary copy
  });
});
