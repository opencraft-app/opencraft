import { describe, expect, it } from "vitest";

import {
  ACLI_RESET_COMMAND,
  getAcliResetBlockReason,
  getAcliResetClickAction,
  getResetBlockReason,
  isExecCommandSucceeded,
  isResetConfigRouteMissingError,
  truncateExecOutput,
  type ResettableBot,
} from "../agent-reset-config";

const bot = (id: string, status: ResettableBot["status"] = "running"): ResettableBot => ({ id, status });

describe("getResetBlockReason", () => {
  it("allows the backend to decide gateway compatibility for main and named Profiles", () => {
    expect(getResetBlockReason(bot("main"), false)).toBeNull();
    expect(getResetBlockReason(bot("sales"), false)).toBeNull();
  });
  it("allows reset when running and not already resetting", () => {
    expect(getResetBlockReason(bot("a"), false)).toBeNull();
  });

  it("blocks when no active bot", () => {
    expect(getResetBlockReason(undefined, false)).toBe("no_active_bot");
  });

  it("blocks when reset is already in progress (debounce)", () => {
    expect(getResetBlockReason(bot("a"), true)).toBe("already_resetting");
  });

  it("blocks when bot is not running", () => {
    /* 与同 page 的"重启 Gateway"按钮保持一致——非 running 时下发 acli
     * 命令必然失败，此时启动 reset 会让 ctl 数据库 key 已 rotate 但
     * 实例没拿到，体验差。 */
    expect(getResetBlockReason(bot("a", "paused"), false)).toBe("not_running");
    expect(getResetBlockReason(bot("a", "provisioning"), false)).toBe("not_running");
    expect(getResetBlockReason(bot("a", "failed"), false)).toBe("not_running");
    expect(getResetBlockReason(bot("a", "deleting"), false)).toBe("not_running");
    expect(getResetBlockReason(bot("a", "draft"), false)).toBe("not_running");
  });

  it("prefers no_active_bot over other reasons", () => {
    expect(getResetBlockReason(undefined, true)).toBe("no_active_bot");
  });
});

describe("getAcliResetBlockReason", () => {
  it("allows acli reset for a running bot when no reset is in progress", () => {
    expect(getAcliResetBlockReason(bot("a"), false)).toBeNull();
  });

  it("blocks acli reset when there is no active bot", () => {
    expect(getAcliResetBlockReason(undefined, false)).toBe("no_active_bot");
  });

  it("blocks acli reset while another acli reset is running", () => {
    expect(getAcliResetBlockReason(bot("a"), true)).toBe("already_resetting");
  });

  it("blocks acli reset for non-running bots", () => {
    expect(getAcliResetBlockReason(bot("a", "paused"), false)).toBe("not_running");
    expect(getAcliResetBlockReason(bot("a", "provisioning"), false)).toBe("not_running");
  });
});

describe("getAcliResetClickAction", () => {
  it("opens a confirmation dialog instead of executing immediately when reset is allowed", () => {
    expect(getAcliResetClickAction(bot("a"), false)).toBe("open_confirm");
  });

  it("keeps disabled reset clicks blocked", () => {
    expect(getAcliResetClickAction(bot("a", "paused"), false)).toBe("blocked");
    expect(getAcliResetClickAction(bot("a"), true)).toBe("blocked");
  });
});

describe("ACLI_RESET_COMMAND", () => {
  it("updates the bundle and follows the release default for every site", () => {
    expect(ACLI_RESET_COMMAND).toBe(
      "acli bundle-update && acli backend upgrade-start --blueprint-id latest --wait=true --force=true",
    );
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

describe("isResetConfigRouteMissingError", () => {
  it("detects old CTL route-missing NOT_FOUND errors", () => {
    const err = Object.assign(
      new Error("resource not found（NOT_FOUND, request_id=abc）"),
      { status: 404, code: "NOT_FOUND" },
    );

    expect(isResetConfigRouteMissingError(err)).toBe(true);
  });

  it("does not treat other 404 errors as old CTL route misses", () => {
    const err = Object.assign(
      new Error("instance not found（NOT_FOUND, request_id=abc）"),
      { status: 404, code: "NOT_FOUND" },
    );

    expect(isResetConfigRouteMissingError(err)).toBe(false);
  });

  it("requires the NOT_FOUND code", () => {
    const err = Object.assign(
      new Error("resource not found"),
      { status: 404, code: "SOME_OTHER_CODE" },
    );

    expect(isResetConfigRouteMissingError(err)).toBe(false);
  });
});
