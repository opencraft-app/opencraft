import { describe, expect, it } from "vitest";

import {
  buildProfileMetaReadCommand,
  buildProfileMetaWriteCommand,
} from "@/lib/hermes-profile-meta";
import { buildBuddySetupPlan } from "@/pages/marketing/agent-buddy-setup";

/**
 * 多 bot 隔离守卫。
 *
 * 多 bot = hermes 多 profile，每个 bot 有自己的 profile 目录：
 *   主 bot    → ~/.hermes
 *   其他 bot  → ~/.hermes/profiles/<profileId>
 *
 * 所有写入都必须落在目标 bot 的目录里。写错 profile 的后果是「在 A bot
 * 填的资料出现在 B bot」，而且用户很难看出是哪一步串了，所以这里逐项守。
 */
describe("multi-bot profile isolation", () => {
  const profile = { name: "研究员", description: "帮我读论文" };

  it("targets the named profile directory, not the main one", () => {
    const command = buildProfileMetaWriteCommand(
      { displayName: "研究员", description: "帮我读论文" },
      "bot-research",
    );
    // 实际形态：HERMES_PROFILE_ROOT="${HERMES_HOME:-$HOME/.hermes}/profiles/"'bot-research'
    expect(command).toContain("/profiles/");
    expect(command).toContain("'bot-research'");
  });

  it("uses the bare home for the main profile", () => {
    const command = buildProfileMetaWriteCommand({ displayName: "主" }, "main");
    expect(command).toContain("${HERMES_HOME:-$HOME/.hermes}");
    expect(command).not.toContain("/profiles/");
  });

  it("keeps reads scoped to the same profile as writes", () => {
    const read = buildProfileMetaReadCommand("bot-research");
    expect(read).toContain("/profiles/");
    expect(read).toContain("'bot-research'");
  });

  it("routes every setup step to the target profile", () => {
    const steps = buildBuddySetupPlan({
      profile,
      profileId: "bot-research",
      avatar: { shapeId: "blob", color: "#B7A6F3" },
      timestamp: "20260916",
    });
    expect(steps.length).toBeGreaterThan(0);
    for (const step of steps) {
      // 每一步都必须指向目标 profile；漏一步就会写到主 bot 上
      expect(step.command, `${step.kind} must target bot-research`)
        .toContain("bot-research");
    }
  });

  it("never falls back to the main profile for a different bot", () => {
    const steps = buildBuddySetupPlan({
      profile,
      profileId: "bot-research",
      timestamp: "20260916",
    });
    for (const step of steps) {
      /*
       * 曾经的缺陷：页面用 `provisioningBot?.profileId ?? "main"` 兜底，
       * bots 列表未就绪时会把新 bot 的资料写进主 bot。
       * 这条断言确保计划里不会出现主 bot 的裸根路径。
       */
      const hasBareHome = /HERMES_(PROFILE_ROOT|ROOT)="\$\{HERMES_HOME:-\$HOME\/\.hermes\}"(?!\/)/
        .test(step.command);
      expect(hasBareHome, `${step.kind} leaked to the main profile`).toBe(false);
    }
  });
});
