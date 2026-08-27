import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  getHermesCommonSettingResetValue,
  isHermesCommonSettingAtResetTarget,
  parseHermesCommonSettingsSnapshot,
  requiresHermesCommonSettingGatewayRestart,
  validateHermesCommonSetting,
} from "../agent-common-settings";

const snapshotOutput = () => [
  HERMES_COMMON_SETTINGS_JSON_START,
  JSON.stringify({
    values: {
      approvalMode: "off",
      destructiveSlashConfirm: false,
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
  it("reads the eight allowlisted resolved values and detects raw YAML defaults", () => {
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
    expect(command).toContain('"approvals.mode"');
    expect(command).toContain('"approvals.destructive_slash_confirm"');
    expect(command).not.toContain("shell=True");
    expect(command).toContain("valid_value");
  });

  it("parses values together with defaulted and unsupported field metadata", () => {
    expect(parseHermesCommonSettingsSnapshot(snapshotOutput())).toEqual({
      values: {
        approvalMode: "off",
        destructiveSlashConfirm: false,
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

  it("keeps other settings readable when Hermes returns an unknown approval mode", () => {
    const root = mkdtempSync(join(tmpdir(), "lightvela-hermes-settings-"));
    const binDir = join(root, "bin");
    const configPath = join(root, "config.yaml");
    const hermesPath = join(binDir, "hermes");
    mkdirSync(binDir);
    writeFileSync(configPath, "approvals:\n  mode: auto\n  destructive_slash_confirm: false\n", "utf8");
    writeFileSync(join(root, "yaml.py"), "def safe_load(_text):\n    return {'approvals': {'mode': 'auto', 'destructive_slash_confirm': False}}\n", "utf8");
    writeFileSync(hermesPath, `#!/bin/sh
if [ "$1" = "config" ] && [ "$2" = "path" ]; then
  printf '%s\\n' "$FAKE_HERMES_CONFIG_PATH"
  exit 0
fi
if [ "$1" = "config" ] && [ "$2" = "get" ]; then
  case "$3" in
    approvals.mode) printf '%s\\n' '"auto"' ;;
    approvals.destructive_slash_confirm) printf '%s\\n' 'false' ;;
    memory.memory_enabled|memory.user_profile_enabled|compression.enabled) printf '%s\\n' 'true' ;;
    compression.threshold) printf '%s\\n' '0.5' ;;
    compression.target_ratio) printf '%s\\n' '0.2' ;;
    compression.protect_last_n) printf '%s\\n' '20' ;;
    *) exit 1 ;;
  esac
  exit 0
fi
exit 1
`, "utf8");
    chmodSync(hermesPath, 0o755);

    try {
      const output = execFileSync("/bin/sh", ["-c", buildHermesCommonSettingsReadCommand()], {
        encoding: "utf8",
        env: {
          ...process.env,
          FAKE_HERMES_CONFIG_PATH: configPath,
          HERMES_HOME: root,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
          PYTHONPATH: root,
        },
      });

      expect(parseHermesCommonSettingsSnapshot(output)).toMatchObject({
        values: { approvalMode: "smart", persistentMemory: true },
        unsupportedKeys: ["approvalMode"],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects malformed or out-of-range snapshots", () => {
    const invalid = [
      HERMES_COMMON_SETTINGS_JSON_START,
      JSON.stringify({
        values: {
          approvalMode: "off",
          destructiveSlashConfirm: false,
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
    expect(getHermesCommonSettingKeysForGroup("security")).toEqual([
      "approvalMode",
      "destructiveSlashConfirm",
    ]);
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

  it("reads both Security settings and keeps the reset scope isolated", () => {
    const command = buildHermesCommonSettingsReadCommand();

    expect(command).toContain('"approvalMode": ("approvals.mode", "smart")');
    expect(command).toContain('"destructiveSlashConfirm": ("approvals.destructive_slash_confirm", True)');
    expect(command).toContain('field == "approvalMode"');
    expect(getHermesCommonSettingKeysForGroup("security")).toEqual([
      "approvalMode",
      "destructiveSlashConfirm",
    ]);
    expect(parseHermesCommonSettingsSnapshot(snapshotOutput()).values.approvalMode).toBe("off");
    expect(parseHermesCommonSettingsSnapshot(snapshotOutput()).values.destructiveSlashConfirm).toBe(false);
  });

  it("accepts only the three documented approval modes", () => {
    expect(validateHermesCommonSetting("approvalMode", "smart")).toEqual({ ok: true, value: "smart" });
    expect(validateHermesCommonSetting("approvalMode", "manual")).toEqual({ ok: true, value: "manual" });
    expect(validateHermesCommonSetting("approvalMode", "off")).toEqual({ ok: true, value: "off" });
    expect(validateHermesCommonSetting("approvalMode", "always" as never)).toEqual({ ok: false, reason: "type" });
    expect(validateHermesCommonSetting("approvalMode", true)).toEqual({ ok: false, reason: "type" });
  });

  it("builds approval commands from the static allowlist", () => {
    expect(buildHermesCommonSettingCommand("approvalMode", "smart")).toBe(
      "hermes config set approvals.mode smart",
    );
    expect(buildHermesCommonSettingUnsetCommand("approvalMode")).toBe(
      "hermes config unset approvals.mode",
    );
    expect(() => buildHermesCommonSettingCommand("approvalMode", "always" as never)).toThrow("invalid");
    expect(buildHermesCommonSettingCommand("destructiveSlashConfirm", false)).toBe(
      "hermes config set approvals.destructive_slash_confirm false",
    );
    expect(validateHermesCommonSetting("destructiveSlashConfirm", true)).toEqual({ ok: true, value: true });
    expect(validateHermesCommonSetting("destructiveSlashConfirm", "false")).toEqual({ ok: false, reason: "type" });
  });

  it("marks both Security settings as immediate", () => {
    expect(requiresHermesCommonSettingGatewayRestart("approvalMode")).toBe(false);
    expect(requiresHermesCommonSettingGatewayRestart("destructiveSlashConfirm")).toBe(false);
    expect(requiresHermesCommonSettingGatewayRestart("persistentMemory")).toBe(true);
    expect(requiresHermesCommonSettingGatewayRestart("compressionThreshold")).toBe(true);
  });

  it("uses LightVela presets as the Security reset target", () => {
    const current = parseHermesCommonSettingsSnapshot(snapshotOutput());

    expect(getHermesCommonSettingResetValue("approvalMode")).toBe("off");
    expect(getHermesCommonSettingResetValue("destructiveSlashConfirm")).toBe(false);
    expect(getHermesCommonSettingResetValue("persistentMemory")).toBeUndefined();
    expect(isHermesCommonSettingAtResetTarget("approvalMode", current)).toBe(true);
    expect(isHermesCommonSettingAtResetTarget("destructiveSlashConfirm", current)).toBe(true);
    expect(isHermesCommonSettingAtResetTarget("persistentMemory", current)).toBe(false);
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
