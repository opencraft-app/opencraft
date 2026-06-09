import { describe, expect, it } from "vitest";
import type { BotRepository } from "@/repositories/types";
import {
  AchievementPayloadError,
  buildHermesAchievementsCommand,
  fetchHermesAchievements,
  parseHermesAchievementsOutput,
} from "@/pages/marketing/openclaw-achievements";
import {
  achievementCriteriaText,
  achievementErrorMessage,
  achievementDisplayDescription,
  achievementDisplayName,
  achievementTimestampLocale,
} from "@/pages/marketing/openclaw-achievements-panel";

const START = "__LIGHTVELA_ACHIEVEMENTS_JSON_START__";
const END = "__LIGHTVELA_ACHIEVEMENTS_JSON_END__";
const testT = (zh: string, options?: Record<string, unknown>) => {
  if (!options) {
    return `i18n:${zh}`;
  }
  return `i18n:${zh.replace(/\{\{\s*([\w$]+)\s*\}\}/g, (_, key: string) => String(options[key] ?? ""))}`;
};
const plainT = (zh: string, options?: Record<string, unknown>) => {
  if (!options) {
    return zh;
  }
  return zh.replace(/\{\{\s*([\w$]+)\s*\}\}/g, (_, key: string) => String(options[key] ?? ""));
};

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
    expect(achievementErrorMessage({ code: "json_parse_failed" }, testT)).toBe("i18n:成就数据解析失败，请稍后重试。");
    expect(achievementErrorMessage({ code: "command_failed" }, testT)).toBe("i18n:成就命令执行失败，请检查 Hermes 服务状态。");
    expect(achievementErrorMessage({ code: "unknown" }, testT)).toBe("i18n:成就数据读取失败");
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

  it("localizes tiered achievement criteria", () => {
    const achievement = {
      id: "autonomous_avalanche",
      name: "Autonomous Avalanche",
      description: "Accumulate a lifetime avalanche of Hermes tool calls across sessions.",
      category: "Agent Autonomy",
      criteria: "Requirement: lifetime Hermes tool calls. Tier ladder: Copper 1000, Silver 3000, Gold 8000.",
      state: "discovered",
      unlocked: false,
    } as const;

    expect(achievementCriteriaText(achievement, plainT, "zh-CN")).toBe(
      "计数指标：累计 Hermes 工具调用次数。等级门槛：铜 1000、银 3000、金 8000。",
    );
  });

  it("localizes multi-condition achievement criteria", () => {
    const achievement = {
      id: "full_send",
      name: "Full Send",
      description: "Terminal, files, and web/browser all get involved in one real run.",
      category: "Agent Autonomy",
      criteria: "Requirement: terminal calls in one session ≥ 180; file/search/patch calls in one session ≥ 120.",
      state: "discovered",
      unlocked: false,
    } as const;

    expect(achievementCriteriaText(achievement, plainT, "zh-CN")).toBe(
      "需要同时满足：单次会话中的终端调用次数 不少于 180；单次会话中的文件、搜索或补丁调用次数 不少于 120。",
    );
  });

  it("hides secret achievement criteria details before discovery", () => {
    const achievement = {
      id: "port_3000_taken",
      name: "???",
      description: "Secret achievement: hidden until Hermes detects the first relevant behavior in your session history.",
      category: "Debugging Chaos",
      criteria: "Secret: exact requirement hidden until Hermes sees the first matching signal. Keep using Hermes across debugging, tools, memory, skills, plugins, and model workflows to reveal it.",
      state: "secret",
      unlocked: false,
    } as const;

    expect(achievementCriteriaText(achievement, plainT, "zh-CN")).toBe(
      "隐藏成就的具体条件会在 Hermes 发现相关行为后展示。继续在调试、工具、记忆、技能、插件和模型工作流中使用 Hermes。",
    );
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
