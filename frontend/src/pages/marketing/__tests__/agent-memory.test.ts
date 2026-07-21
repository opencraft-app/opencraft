import { describe, expect, it } from "vitest";

import {
  DEFAULT_MEMORY_CHAR_LIMIT,
  DEFAULT_USER_CHAR_LIMIT,
  HERMES_MEMORY_CHAR_LIMIT_MAX,
  HERMES_MEMORY_LIMIT_SAFE_BUFFER,
  HERMES_MEMORY_LIMIT_MIN,
  HERMES_USER_CHAR_LIMIT_MAX,
  buildHermesMemoryLimitCommand,
  buildHermesMemoryReadCommand,
  getHermesMemoryLimitBounds,
  getMemoryUsagePercent,
  isHermesMemoryLimitNearUsage,
  parseHermesMemorySnapshot,
  splitHermesMemoryEntries,
  toSingleLineMemoryEntry,
  validateHermesMemoryLimit,
} from "../agent-memory";

describe("buildHermesMemoryReadCommand", () => {
  it("reads Hermes config and memory files from the instance home directory", () => {
    const command = buildHermesMemoryReadCommand();

    expect(command).toContain("python3 - <<'PY'");
    expect(command).toContain(".hermes");
    expect(command).toContain("config.yaml");
    expect(command).toContain("MEMORY.md");
    expect(command).toContain("USER.md");
    expect(command).toContain(String(DEFAULT_MEMORY_CHAR_LIMIT));
    expect(command).toContain(String(DEFAULT_USER_CHAR_LIMIT));
  });
});

describe("parseHermesMemorySnapshot", () => {
  it("parses the structured debug/exec output", () => {
    const snapshot = parseHermesMemorySnapshot(JSON.stringify({
      memoryCharLimit: 2200,
      userCharLimit: 1375,
      memoryChars: 12,
      userChars: 8,
      memoryText: "alpha",
      userText: "beta",
      usedFallbackLimits: false,
    }));

    expect(snapshot).toEqual({
      memoryCharLimit: 2200,
      userCharLimit: 1375,
      memoryChars: 12,
      userChars: 8,
      memoryText: "alpha",
      userText: "beta",
      usedFallbackLimits: false,
    });
  });

  it("falls back when optional numeric fields are missing", () => {
    const snapshot = parseHermesMemorySnapshot(JSON.stringify({
      memoryText: "agent note",
      userText: "user note",
      usedFallbackLimits: true,
    }));

    expect(snapshot.memoryCharLimit).toBe(DEFAULT_MEMORY_CHAR_LIMIT);
    expect(snapshot.userCharLimit).toBe(DEFAULT_USER_CHAR_LIMIT);
    expect(snapshot.memoryChars).toBe(0);
    expect(snapshot.userChars).toBe(0);
    expect(snapshot.usedFallbackLimits).toBe(true);
  });

  it("can parse JSON wrapped by transport noise", () => {
    const snapshot = parseHermesMemorySnapshot(`stdout:\n${JSON.stringify({
      memoryCharLimit: 100,
      userCharLimit: 50,
      memoryChars: 20,
      userChars: 10,
    })}\n`);

    expect(snapshot.memoryCharLimit).toBe(100);
    expect(snapshot.userCharLimit).toBe(50);
    expect(snapshot.memoryChars).toBe(20);
    expect(snapshot.userChars).toBe(10);
  });

  it("throws for non-json output", () => {
    expect(() => parseHermesMemorySnapshot("Traceback: python3 not found")).toThrow("memory payload is not valid JSON");
  });
});

describe("validateHermesMemoryLimit", () => {
  it("accepts target-specific boundary values", () => {
    expect(validateHermesMemoryLimit("memory", String(HERMES_MEMORY_LIMIT_MIN))).toEqual({
      ok: true,
      value: HERMES_MEMORY_LIMIT_MIN,
      min: HERMES_MEMORY_LIMIT_MIN,
      max: HERMES_MEMORY_CHAR_LIMIT_MAX,
    });
    expect(validateHermesMemoryLimit("memory", String(HERMES_MEMORY_CHAR_LIMIT_MAX))).toEqual({
      ok: true,
      value: HERMES_MEMORY_CHAR_LIMIT_MAX,
      min: HERMES_MEMORY_LIMIT_MIN,
      max: HERMES_MEMORY_CHAR_LIMIT_MAX,
    });
    expect(validateHermesMemoryLimit("user", String(HERMES_USER_CHAR_LIMIT_MAX))).toEqual({
      ok: true,
      value: HERMES_USER_CHAR_LIMIT_MAX,
      min: HERMES_MEMORY_LIMIT_MIN,
      max: HERMES_USER_CHAR_LIMIT_MAX,
    });
  });

  it("rejects empty, non-integer, and out-of-range values", () => {
    expect(validateHermesMemoryLimit("memory", "").ok).toBe(false);
    expect(validateHermesMemoryLimit("memory", "1200.5").ok).toBe(false);
    expect(validateHermesMemoryLimit("memory", String(HERMES_MEMORY_LIMIT_MIN - 1))).toMatchObject({
      ok: false,
      reason: "too_small",
    });
    expect(validateHermesMemoryLimit("memory", String(HERMES_MEMORY_CHAR_LIMIT_MAX + 1))).toMatchObject({
      ok: false,
      reason: "too_large",
    });
    expect(validateHermesMemoryLimit("user", String(HERMES_USER_CHAR_LIMIT_MAX + 1))).toMatchObject({
      ok: false,
      reason: "too_large",
    });
  });

  it("uses existing memory characters as the dynamic lower bound", () => {
    expect(validateHermesMemoryLimit("memory", "1199", 1200)).toEqual({
      ok: false,
      reason: "too_small",
      min: 1200,
      max: HERMES_MEMORY_CHAR_LIMIT_MAX,
    });
    expect(validateHermesMemoryLimit("memory", "1200", 1200)).toEqual({
      ok: true,
      value: 1200,
      min: 1200,
      max: HERMES_MEMORY_CHAR_LIMIT_MAX,
    });
    expect(validateHermesMemoryLimit("user", "899", 900)).toMatchObject({
      ok: false,
      reason: "too_small",
      min: 900,
      max: HERMES_USER_CHAR_LIMIT_MAX,
    });
  });

  it("ignores invalid existing character counts when deriving bounds", () => {
    expect(getHermesMemoryLimitBounds("memory", Number.NaN).min).toBe(HERMES_MEMORY_LIMIT_MIN);
    expect(getHermesMemoryLimitBounds("memory", Number.POSITIVE_INFINITY).min).toBe(HERMES_MEMORY_LIMIT_MIN);
    expect(getHermesMemoryLimitBounds("user", -1).min).toBe(HERMES_MEMORY_LIMIT_MIN);
  });
});

describe("buildHermesMemoryLimitCommand", () => {
  it("builds target-specific Hermes config commands", () => {
    expect(buildHermesMemoryLimitCommand("memory", 4000)).toBe("hermes config set memory.memory_char_limit 4000");
    expect(buildHermesMemoryLimitCommand("user", 3000)).toBe("hermes config set memory.user_char_limit 3000");
  });

  it("throws before building invalid commands", () => {
    expect(() => buildHermesMemoryLimitCommand("memory", 4001)).toThrow("invalid Hermes memory limit");
    expect(() => buildHermesMemoryLimitCommand("user", 3001)).toThrow("invalid Hermes memory limit");
    expect(() => buildHermesMemoryLimitCommand("memory", 999, 1000)).toThrow("invalid Hermes memory limit");
  });
});

describe("isHermesMemoryLimitNearUsage", () => {
  it("warns when lowering the limit too close to current usage", () => {
    expect(isHermesMemoryLimitNearUsage(1199, 1000, 2200)).toBe(true);
    expect(isHermesMemoryLimitNearUsage(1000 + HERMES_MEMORY_LIMIT_SAFE_BUFFER, 1000, 2200)).toBe(false);
  });

  it("does not warn when increasing the limit or passing invalid values", () => {
    expect(isHermesMemoryLimitNearUsage(2500, 1000, 2200)).toBe(false);
    expect(isHermesMemoryLimitNearUsage(Number.NaN, 1000, 2200)).toBe(false);
  });
});

describe("splitHermesMemoryEntries", () => {
  it("splits entries by the Hermes memory delimiter", () => {
    expect(splitHermesMemoryEntries(" first memory § second memory § third memory ")).toEqual([
      "first memory",
      "second memory",
      "third memory",
    ]);
  });

  it("drops empty entries created by repeated delimiters", () => {
    expect(splitHermesMemoryEntries("§ alpha §  § beta §")).toEqual(["alpha", "beta"]);
  });
});

describe("toSingleLineMemoryEntry", () => {
  it("normalizes multiline memories for single-row cards", () => {
    expect(toSingleLineMemoryEntry("alpha\n  beta\tgamma")).toBe("alpha beta gamma");
  });
});

describe("getMemoryUsagePercent", () => {
  it("rounds usage and caps the progress value", () => {
    expect(getMemoryUsagePercent(11, 100)).toBe(11);
    expect(getMemoryUsagePercent(11, 20)).toBe(55);
    expect(getMemoryUsagePercent(200, 100)).toBe(100);
  });

  it("returns zero for invalid limits", () => {
    expect(getMemoryUsagePercent(10, 0)).toBe(0);
    expect(getMemoryUsagePercent(10, -1)).toBe(0);
  });
});
