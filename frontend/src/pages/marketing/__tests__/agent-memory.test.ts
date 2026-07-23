import { describe, expect, it } from "vitest";
import type { BotRepository } from "@/repositories/types";

import {
  DEFAULT_MEMORY_CHAR_LIMIT,
  DEFAULT_USER_CHAR_LIMIT,
  HERMES_MEMORY_COMMAND_TIMEOUT_MS,
  HERMES_MEMORY_JSON_END,
  HERMES_MEMORY_JSON_START,
  HERMES_MEMORY_CHAR_LIMIT_MAX,
  HERMES_MEMORY_LIMIT_SAFE_BUFFER,
  HERMES_MEMORY_LIMIT_MIN,
  HERMES_USER_CHAR_LIMIT_MAX,
  buildHermesMemoryLimitCommand,
  buildHermesMemoryReadCommand,
  fetchHermesMemorySnapshot,
  getHermesMemoryLimitBounds,
  getMemoryUsagePercent,
  isHermesMemoryLimitNearUsage,
  parseHermesMemorySnapshot,
  splitHermesMemoryEntries,
  toSingleLineMemoryEntry,
  validateHermesMemoryLimit,
} from "../agent-memory";

describe("buildHermesMemoryReadCommand", () => {
  it("reads Hermes config and memory files from HERMES_HOME with the default root as fallback", () => {
    const command = buildHermesMemoryReadCommand();

    expect(command).toContain('HERMES_ROOT="${HERMES_HOME:-$HOME/.hermes}"');
    expect(command).toContain('os.environ["HERMES_ROOT"]');
    expect(command).toContain('"$HERMES_ROOT/hermes-agent/venv/bin/python"');
    expect(command).toContain("config.yaml");
    expect(command).toContain("MEMORY.md");
    expect(command).toContain("USER.md");
    expect(command).toContain(String(DEFAULT_MEMORY_CHAR_LIMIT));
    expect(command).toContain(String(DEFAULT_USER_CHAR_LIMIT));
  });

  it("uses safe YAML parsing so canonical inline comments remain valid", () => {
    const command = buildHermesMemoryReadCommand();

    expect(command).toContain("yaml.safe_load");
    expect(command).toContain('config_payload.get("memory"');
    expect(command).not.toContain("re.search");
  });

  it("only treats missing files as empty and lets other read failures surface", () => {
    const command = buildHermesMemoryReadCommand();

    expect(command).toContain("except FileNotFoundError");
    expect(command).not.toContain("except Exception:");
  });

  it("wraps the JSON payload in fixed markers", () => {
    const command = buildHermesMemoryReadCommand();

    expect(command).toContain(HERMES_MEMORY_JSON_START);
    expect(command).toContain(HERMES_MEMORY_JSON_END);
  });
});

describe("parseHermesMemorySnapshot", () => {
  it("parses the structured debug/exec output", () => {
    const snapshot = parseHermesMemorySnapshot([
      "transport noise {not-json}",
      HERMES_MEMORY_JSON_START,
      JSON.stringify({
        memoryCharLimit: 2200,
        userCharLimit: 1375,
        memoryChars: 12,
        userChars: 8,
        memoryText: "alpha",
        userText: "beta",
        usedFallbackLimits: false,
      }),
      HERMES_MEMORY_JSON_END,
    ].join("\n"));

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

  it.each([
    [{}, "memoryCharLimit"],
    [{ memoryCharLimit: "2200" }, "memoryCharLimit"],
    [{
      memoryCharLimit: 2200,
      userCharLimit: 1375,
      memoryChars: -1,
      userChars: 0,
      memoryText: "",
      userText: "",
      usedFallbackLimits: false,
    }, "memoryChars"],
    [{
      memoryCharLimit: 2200,
      userCharLimit: 1375,
      memoryChars: 0,
      userChars: 0,
      memoryText: null,
      userText: "",
      usedFallbackLimits: false,
    }, "memoryText"],
  ])("rejects invalid required payload fields: %s", (payload, field) => {
    const output = [HERMES_MEMORY_JSON_START, JSON.stringify(payload), HERMES_MEMORY_JSON_END].join("\n");
    expect(() => parseHermesMemorySnapshot(output)).toThrow(field);
  });

  it("throws for non-json output", () => {
    expect(() => parseHermesMemorySnapshot("Traceback: python3 not found")).toThrow("memory JSON block was not found");
  });
});

describe("fetchHermesMemorySnapshot", () => {
  it("bounds the remote read command with a two minute timeout", async () => {
    let receivedOptions: { timeoutMs?: number } | undefined;
    const bots = {
      execDebugCommand: async (_botId: string, _command: string, options?: { timeoutMs?: number }) => {
        receivedOptions = options;
        return {
          status: "Succeeded",
          exitCode: 0,
          output: [
            HERMES_MEMORY_JSON_START,
            JSON.stringify({
              memoryCharLimit: 2200,
              userCharLimit: 1375,
              memoryChars: 0,
              userChars: 0,
              memoryText: "",
              userText: "",
              usedFallbackLimits: false,
            }),
            HERMES_MEMORY_JSON_END,
          ].join("\n"),
        };
      },
    } as Pick<BotRepository, "execDebugCommand"> as BotRepository;

    await expect(fetchHermesMemorySnapshot(bots, "bot-1")).resolves.toMatchObject({ memoryChars: 0 });
    expect(receivedOptions).toEqual({ timeoutMs: HERMES_MEMORY_COMMAND_TIMEOUT_MS });
    expect(HERMES_MEMORY_COMMAND_TIMEOUT_MS).toBe(120_000);
  });

  it("surfaces command failures before parsing output", async () => {
    const bots = {
      execDebugCommand: async () => ({ status: "Failed", exitCode: 1, output: "permission denied" }),
    } as Pick<BotRepository, "execDebugCommand"> as BotRepository;

    await expect(fetchHermesMemorySnapshot(bots, "bot-1")).rejects.toThrow("permission denied");
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
