import { describe, expect, it } from "vitest";

import {
  DEFAULT_MEMORY_CHAR_LIMIT,
  DEFAULT_USER_CHAR_LIMIT,
  buildHermesMemoryReadCommand,
  getMemoryUsagePercent,
  parseHermesMemorySnapshot,
  splitHermesMemoryEntries,
  toSingleLineMemoryEntry,
} from "../openclaw-memory";

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
