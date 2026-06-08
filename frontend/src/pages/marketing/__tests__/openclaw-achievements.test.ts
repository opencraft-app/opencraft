import { describe, expect, it } from "vitest";
import type { BotRepository } from "@/repositories/types";
import {
  AchievementPayloadError,
  buildHermesAchievementsCommand,
  fetchHermesAchievements,
  parseHermesAchievementsOutput,
} from "@/pages/marketing/openclaw-achievements";
import {
  achievementErrorMessage,
  achievementDisplayDescription,
  achievementDisplayName,
  achievementTimestampLocale,
} from "@/pages/marketing/openclaw-achievements-panel";

const START = "__LIGHTVELA_ACHIEVEMENTS_JSON_START__";
const END = "__LIGHTVELA_ACHIEVEMENTS_JSON_END__";

describe("openclaw achievements debug exec helpers", () => {
  it("builds a fixed hermes achievements command without caller input", () => {
    const command = buildHermesAchievementsCommand();

    expect(command).toContain("plugins\" / \"hermes-achievements\"");
    expect(command).toContain(START);
    expect(command).toContain(END);
    expect(command).toContain("force_rescan = False");
    expect(command).toContain('getattr(module, "_is_snapshot_stale", None)');
    expect(command).toContain('getattr(module, "_scan_status_payload", None)');
  });

  it("switches the fixed command to force rescan mode", () => {
    expect(buildHermesAchievementsCommand(true)).toContain("force_rescan = True");
  });

  it("parses and normalizes the achievements JSON block", () => {
    const snapshot = parseHermesAchievementsOutput([
      "debug output before payload",
      START,
      JSON.stringify({
        achievements: [
          {
            id: "let_him_cook",
            name: "Let Him Cook",
            description: "Let Hermes run a serious autonomous tool chain in one session.",
            category: "Agent Autonomy",
            state: "unlocked",
            unlocked: true,
            tier: "Copper",
            progress: 240,
            progress_pct: 100,
            unlocked_at: 1_764_000_000,
            evidence: { session_id: "ses_1", title: "Release check", value: 240 },
          },
          {
            id: "hidden_one",
            category: "Debugging Chaos",
            state: "secret",
            unlocked: false,
          },
          {
            id: "badgeless",
            unlocked: false,
          },
        ],
        unlocked_count: 1,
        discovered_count: 1,
        secret_count: 1,
        total_count: 3,
        generated_at: 1_764_000_001,
        is_stale: true,
        scan_meta: {
          mode: "incremental",
          sessions_total: 12,
          status: { state: "idle", run_count: 2, snapshot_stale: true },
        },
      }),
      END,
      "debug output after payload",
    ].join("\n"));

    expect(snapshot.unlocked_count).toBe(1);
    expect(snapshot.is_stale).toBe(true);
    expect(snapshot.scan_meta?.mode).toBe("incremental");
    expect(snapshot.scan_meta?.status?.snapshot_stale).toBe(true);
    expect(snapshot.achievements).toHaveLength(3);
    expect(snapshot.achievements[0]).toMatchObject({
      id: "let_him_cook",
      state: "unlocked",
      tier: "Copper",
      evidence: { title: "Release check" },
    });
    expect(snapshot.achievements[1]).toMatchObject({
      id: "hidden_one",
      name: "???",
      state: "secret",
      description: "",
    });
    expect(snapshot.achievements[2]).toMatchObject({
      id: "badgeless",
      name: "badgeless",
      category: "Other",
      state: "discovered",
    });
  });

  it("throws a typed error when the JSON markers are missing", () => {
    try {
      parseHermesAchievementsOutput("{}");
      throw new Error("Expected parseHermesAchievementsOutput to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(AchievementPayloadError);
      expect((error as AchievementPayloadError).code).toBe("json_block_missing");
    }
  });

  it("surfaces debug exec failures before parsing output", async () => {
    const bots = {
      execDebugCommand: async () => ({ status: "Failed", exitCode: 1, output: "plugin not found" }),
    } as Pick<BotRepository, "execDebugCommand"> as BotRepository;

    await expect(fetchHermesAchievements(bots, "bot-1")).rejects.toMatchObject({
      code: "command_failed",
      message: expect.stringContaining("plugin not found"),
    });
  });

  it("maps achievement errors to localized friendly copy", () => {
    const t = (zh: string) => `i18n:${zh}`;

    expect(achievementErrorMessage({ code: "json_parse_failed" }, t)).toBe("i18n:成就数据解析失败，请稍后重试。");
    expect(achievementErrorMessage({ code: "command_failed" }, t)).toBe("i18n:成就命令执行失败，请检查 Hermes 服务状态。");
    expect(achievementErrorMessage({ code: "unknown" }, t)).toBe("i18n:成就数据读取失败");
  });

  it("derives timestamp locale from the active language", () => {
    expect(achievementTimestampLocale("zh-CN")).toBe("zh-CN");
    expect(achievementTimestampLocale("zh-Hans")).toBe("zh-CN");
    expect(achievementTimestampLocale("en-US")).toBe("en-US");
    expect(achievementTimestampLocale(undefined)).toBe("en-US");
  });

  it("routes known achievement fallback copy through i18n", () => {
    const achievement = {
      id: "let_him_cook",
      name: "Let Him Cook",
      description: "Let Hermes run a serious autonomous tool chain in one session.",
      category: "Agent Autonomy",
      state: "discovered",
      unlocked: false,
    } as const;
    const t = (zh: string) => `i18n:${zh}`;

    expect(achievementDisplayName(achievement, t)).toBe("i18n:甩手掌柜");
    expect(achievementDisplayDescription(achievement, t)).toBe("i18n:让 Hermes 在一次会话中自主完成一条完整工具链。");
  });

  it("falls back to backend achievement copy for unknown ids", () => {
    const achievement = {
      id: "new_backend_achievement",
      name: "New Backend Achievement",
      description: "Fresh copy from the backend plugin.",
      category: "Agent Autonomy",
      state: "discovered",
      unlocked: false,
    } as const;
    const t = (zh: string) => `i18n:${zh}`;

    expect(achievementDisplayName(achievement, t)).toBe("New Backend Achievement");
    expect(achievementDisplayDescription(achievement, t)).toBe("Fresh copy from the backend plugin.");
  });
});
