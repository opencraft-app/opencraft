import { describe, expect, it } from "vitest";
import type { BotRepository } from "@/repositories/types";

import {
  HERMES_COMMON_SETTINGS_JSON_END,
  HERMES_COMMON_SETTINGS_JSON_START,
  HERMES_COMMON_SETTINGS_TIMEOUT_MS,
  buildHermesCommonSettingCommand,
  buildHermesCommonSettingUnsetCommand,
  buildHermesCommonSettingsReadCommand,
  fetchHermesCommonSettingsSnapshot,
  getHermesCommonSettingKeysForGroup,
  parseHermesCommonSettingsSnapshot,
  validateHermesCommonSetting,
} from "../agent-common-settings";

const snapshotOutput = () => [
  HERMES_COMMON_SETTINGS_JSON_START,
  JSON.stringify({
    values: {
      persistentMemory: true,
      userProfile: false,
      autoCompression: true,
      compressionThreshold: 0.5,
      compressionTarget: 0.2,
      protectedRecentMessages: 20,
    },
    defaultedKeys: ["compressionThreshold"],
    unsupportedKeys: ["userProfile"],
  }),
  HERMES_COMMON_SETTINGS_JSON_END,
].join("\n");

describe("Hermes common settings reader", () => {
  it("reads the six allowlisted resolved values and detects raw YAML defaults", () => {
    const command = buildHermesCommonSettingsReadCommand();

    expect(command).toContain('HERMES_ROOT="${HERMES_HOME:-$HOME/.hermes}"');
    expect(command).toContain("yaml.safe_load");
    expect(command).toContain('["hermes", "config", "path"]');
    expect(command).toContain('["hermes", "config", "get", dotted_key, "--json"]');
    expect(command).toContain('"memory.memory_enabled"');
    expect(command).toContain('"memory.user_profile_enabled"');
    expect(command).toContain('"compression.enabled"');
    expect(command).toContain('"compression.threshold"');
    expect(command).toContain('"compression.target_ratio"');
    expect(command).toContain('"compression.protect_last_n"');
    expect(command).not.toContain("shell=True");
    expect(command).toContain("valid_value");
  });

  it("parses values together with defaulted and unsupported field metadata", () => {
    expect(parseHermesCommonSettingsSnapshot(snapshotOutput())).toEqual({
      values: {
        persistentMemory: true,
        userProfile: false,
        autoCompression: true,
        compressionThreshold: 0.5,
        compressionTarget: 0.2,
        protectedRecentMessages: 20,
      },
      defaultedKeys: ["compressionThreshold"],
      unsupportedKeys: ["userProfile"],
    });
  });

  it("rejects malformed or out-of-range snapshots", () => {
    const invalid = [
      HERMES_COMMON_SETTINGS_JSON_START,
      JSON.stringify({
        values: {
          persistentMemory: true,
          userProfile: true,
          autoCompression: true,
          compressionThreshold: 1.2,
          compressionTarget: 0.2,
          protectedRecentMessages: 20,
        },
        defaultedKeys: [],
        unsupportedKeys: [],
      }),
      HERMES_COMMON_SETTINGS_JSON_END,
    ].join("\n");

    expect(() => parseHermesCommonSettingsSnapshot(invalid)).toThrow("compressionThreshold");
    expect(() => parseHermesCommonSettingsSnapshot("plain text")).toThrow("JSON block");
  });

  it("bounds remote reads with the shared timeout", async () => {
    let receivedOptions: { timeoutMs?: number } | undefined;
    const bots = {
      execDebugCommand: async (_botId: string, _command: string, options?: { timeoutMs?: number }) => {
        receivedOptions = options;
        return { status: "Succeeded", exitCode: 0, output: snapshotOutput() };
      },
    } as Pick<BotRepository, "execDebugCommand"> as BotRepository;

    await expect(fetchHermesCommonSettingsSnapshot(bots, "bot-a")).resolves.toMatchObject({
      values: { persistentMemory: true },
    });
    expect(receivedOptions).toEqual({ timeoutMs: HERMES_COMMON_SETTINGS_TIMEOUT_MS });
  });
});

describe("Hermes common setting validation", () => {
  it("keeps memory and context reset scopes isolated", () => {
    expect(getHermesCommonSettingKeysForGroup("memory")).toEqual([
      "persistentMemory",
      "userProfile",
    ]);
    expect(getHermesCommonSettingKeysForGroup("context")).toEqual([
      "autoCompression",
      "compressionThreshold",
      "compressionTarget",
      "protectedRecentMessages",
    ]);
  });

  it("builds unset commands only from the static setting allowlist", () => {
    expect(buildHermesCommonSettingUnsetCommand("persistentMemory")).toBe(
      "hermes config unset memory.memory_enabled",
    );
    expect(buildHermesCommonSettingUnsetCommand("compressionTarget")).toBe(
      "hermes config unset compression.target_ratio",
    );
  });

  it("accepts documented numeric boundaries", () => {
    expect(validateHermesCommonSetting("compressionThreshold", "0")).toMatchObject({ ok: true, value: 0 });
    expect(validateHermesCommonSetting("compressionThreshold", "1")).toMatchObject({ ok: true, value: 1 });
    expect(validateHermesCommonSetting("compressionTarget", "0.1")).toMatchObject({ ok: true, value: 0.1 });
    expect(validateHermesCommonSetting("compressionTarget", "0.8")).toMatchObject({ ok: true, value: 0.8 });
    expect(validateHermesCommonSetting("protectedRecentMessages", "1")).toMatchObject({ ok: true, value: 1 });
  });

  it("rejects empty, invalid, and out-of-range numeric input", () => {
    expect(validateHermesCommonSetting("compressionThreshold", "")).toMatchObject({ ok: false, reason: "empty" });
    expect(validateHermesCommonSetting("compressionThreshold", "1.1")).toMatchObject({ ok: false, reason: "range" });
    expect(validateHermesCommonSetting("compressionTarget", "0.09")).toMatchObject({ ok: false, reason: "range" });
    expect(validateHermesCommonSetting("protectedRecentMessages", "1.5")).toMatchObject({ ok: false, reason: "integer" });
    expect(validateHermesCommonSetting("protectedRecentMessages", "0")).toMatchObject({ ok: false, reason: "range" });
  });

  it("only builds commands for typed values and static allowlisted keys", () => {
    expect(buildHermesCommonSettingCommand("persistentMemory", false)).toBe(
      "hermes config set memory.memory_enabled false",
    );
    expect(buildHermesCommonSettingCommand("compressionThreshold", 0.65)).toBe(
      "hermes config set compression.threshold 0.65",
    );
    expect(buildHermesCommonSettingCommand("protectedRecentMessages", 30)).toBe(
      "hermes config set compression.protect_last_n 30",
    );
    expect(() => buildHermesCommonSettingCommand("compressionTarget", 0.01)).toThrow("invalid");
  });
});
