import { describe, expect, it } from "vitest";

import {
  getResetBlockReason,
  hermesModelName,
  hermesSwitchModelFullId,
  isExecCommandSucceeded,
  truncateExecOutput,
  type ResettableBot,
} from "../openclaw-reset-config";

const bot = (id: string, status: ResettableBot["status"] = "running"): ResettableBot => ({ id, status });

describe("getResetBlockReason", () => {
  it("allows reset when running, not already resetting, and channel was viewed", () => {
    expect(getResetBlockReason(bot("a"), false, true)).toBeNull();
  });

  it("blocks when no active bot", () => {
    expect(getResetBlockReason(undefined, false, true)).toBe("no_active_bot");
  });

  it("blocks when reset is already in progress (debounce)", () => {
    expect(getResetBlockReason(bot("a"), true, true)).toBe("already_resetting");
  });

  it("blocks when bot is not running", () => {
    /* 与同 page 的"重启 Gateway"按钮保持一致——非 running 时下发 acli
     * 命令必然失败，此时启动 reset 会让 ctl 数据库 key 已 rotate 但
     * 实例没拿到，体验差。 */
    expect(getResetBlockReason(bot("a", "paused"), false, true)).toBe("not_running");
    expect(getResetBlockReason(bot("a", "provisioning"), false, true)).toBe("not_running");
    expect(getResetBlockReason(bot("a", "failed"), false, true)).toBe("not_running");
    expect(getResetBlockReason(bot("a", "deleting"), false, true)).toBe("not_running");
    expect(getResetBlockReason(bot("a", "draft"), false, true)).toBe("not_running");
  });

  it("blocks when channel tab has not been viewed yet", () => {
    /* 通道 tab 在 mount 时会触发 SDK bootstrap → acli self-update，让存量
     * 实例升级到支持 `acli backend reset-config` 子命令的版本。
     * 没访问过通道 tab 直接点重置可能命中"unknown command"失败。 */
    expect(getResetBlockReason(bot("a"), false, false)).toBe("channel_not_viewed");
  });

  it("prefers no_active_bot over other reasons", () => {
    expect(getResetBlockReason(undefined, true, false)).toBe("no_active_bot");
  });

  it("prefers not_running over channel_not_viewed", () => {
    /* 优先级：no_active_bot > already_resetting > not_running > channel_not_viewed
     * 让用户看到最根本的阻塞原因。 */
    expect(getResetBlockReason(bot("a", "paused"), false, false)).toBe("not_running");
  });
});

describe("hermesModelName", () => {
  it("returns the segment after the last slash for prefixed model ids", () => {
    expect(hermesModelName("openai/gpt-4o")).toBe("gpt-4o");
    expect(hermesModelName("anthropic/claude-3-5-sonnet")).toBe("claude-3-5-sonnet");
  });

  it("uses the last slash so multi-level ids still resolve", () => {
    /* 与 ctl 后端 hermesModelName 等价：strings.LastIndex(modelID, "/") */
    expect(hermesModelName("provider/group/model-x")).toBe("model-x");
  });

  it("returns the original string when there is no slash", () => {
    expect(hermesModelName("gpt-4o")).toBe("gpt-4o");
  });

  it("trims surrounding whitespace before processing", () => {
    expect(hermesModelName("  openai/gpt-4o  ")).toBe("gpt-4o");
  });

  it("returns empty string for blank or empty input", () => {
    expect(hermesModelName("")).toBe("");
    expect(hermesModelName("   ")).toBe("");
  });

  it("returns the original (trimmed) value when the slash is at the end", () => {
    /* 边界：`openai/` 取不到合法 suffix 时回退到原值，避免返回空串误导调用方 */
    expect(hermesModelName("openai/")).toBe("openai/");
  });
});

describe("hermesSwitchModelFullId", () => {
  it("uses modelId as-is when it already contains a slash", () => {
    expect(hermesSwitchModelFullId("custom", "openai/gpt-4o")).toBe("openai/gpt-4o");
  });

  it("joins providerName and modelId when modelId is not prefixed", () => {
    expect(hermesSwitchModelFullId("openai", "gpt-4o")).toBe("openai/gpt-4o");
  });

  it("trims whitespace from both sides before joining", () => {
    expect(hermesSwitchModelFullId("  openai  ", "  gpt-4o  ")).toBe("openai/gpt-4o");
  });

  it("preserves the slash convention used by the backend python parser", () => {
    /* 与 ctl 后端 renderHermesModelSetCommand 里的 python 解析器一致：
     *   if "/" in model: print(model)
     *   elif provider and model: print(provider + "/" + model)
     */
    expect(hermesSwitchModelFullId("custom", "anthropic/claude")).toBe("anthropic/claude");
  });
});

describe("isExecCommandSucceeded", () => {
  it("returns true when status is SUCCESS and exitCode is 0", () => {
    expect(isExecCommandSucceeded({ status: "SUCCESS", exitCode: 0 })).toBe(true);
  });

  it("accepts the legacy lower-case Succeeded variant", () => {
    /* fake repository 返回 'Succeeded'（envd 风格），http repository 返回
     * 'SUCCESS'（ctl 透传）；统一向上转再比较，避免大小写差异断链。 */
    expect(isExecCommandSucceeded({ status: "Succeeded", exitCode: 0 })).toBe(true);
    expect(isExecCommandSucceeded({ status: "success", exitCode: 0 })).toBe(true);
  });

  it("rejects non-zero exitCode even when status looks fine", () => {
    expect(isExecCommandSucceeded({ status: "SUCCESS", exitCode: 1 })).toBe(false);
  });

  it("rejects unknown statuses", () => {
    expect(isExecCommandSucceeded({ status: "FAILED", exitCode: 0 })).toBe(false);
    expect(isExecCommandSucceeded({ status: "TIMEOUT", exitCode: 0 })).toBe(false);
    expect(isExecCommandSucceeded({ status: "", exitCode: 0 })).toBe(false);
  });

  it("trims whitespace around status", () => {
    expect(isExecCommandSucceeded({ status: "  SUCCESS  ", exitCode: 0 })).toBe(true);
  });
});

describe("truncateExecOutput", () => {
  it("returns the trimmed output when shorter than the cap", () => {
    expect(truncateExecOutput("  some short output  ", "FAILED")).toBe("some short output");
  });

  it("falls back to status when output is empty / whitespace / undefined", () => {
    expect(truncateExecOutput("", "FAILED")).toBe("FAILED");
    expect(truncateExecOutput("   ", "TIMEOUT")).toBe("TIMEOUT");
    expect(truncateExecOutput(undefined, "TIMEOUT")).toBe("TIMEOUT");
  });

  it("keeps the tail (most relevant for stack traces / final error lines)", () => {
    /* 设计选择：长输出留尾巴而不是开头，因为 acli 的失败原因
     * 通常出现在结尾的 panic / RuntimeError，开头多是启动日志噪声。 */
    const long = "a".repeat(2000) + "BOOM";
    const result = truncateExecOutput(long, "FAILED", 100);
    expect(result.startsWith("…")).toBe(true);
    expect(result.endsWith("BOOM")).toBe(true);
    expect(result.length).toBe(101); // "…" + 100 chars
  });

  it("respects custom maxBytes parameter", () => {
    const long = "x".repeat(50);
    expect(truncateExecOutput(long, "FAILED", 10)).toBe("…" + "x".repeat(10));
  });

  it("does not add ellipsis when output is exactly at the cap", () => {
    const exact = "y".repeat(20);
    expect(truncateExecOutput(exact, "FAILED", 20)).toBe(exact);
  });

  it("preserves multi-line output verbatim (caller renders with whitespace-pre-wrap)", () => {
    const multiline = "error: top\n  at frame1\n  at frame2";
    expect(truncateExecOutput(multiline, "FAILED")).toBe(multiline);
  });
});
