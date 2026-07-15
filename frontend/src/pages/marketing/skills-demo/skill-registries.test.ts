import { describe, expect, it } from "vitest";

import {
  buildSkillhubInstallCommand,
  buildSkillhubListCommand,
  buildSkillhubUninstallCommand,
  buildSkillsshInstallCommand,
  buildSkillsshSearchCommand,
  buildSkillsshUninstallCommand,
  getPopularityTier,
  mergeInstalledSources,
  skillIdentity,
  type InstalledSkill,
} from "./skill-registries";
import { parseSkillhubList, parseSkillhubSearch } from "./skill-registries";

describe("skills.sh command builders", () => {
  it("runs installs in agentuser's login-shell context", () => {
    const command = buildSkillsshInstallCommand("anthropics/skills/frontend-design");

    expect(command).toBe('bash -lc \'cd "$HOME" && acli skills-sh install anthropics/skills/frontend-design\'');
  });

  it("runs uninstalls in agentuser's login-shell context", () => {
    const command = buildSkillsshUninstallCommand("anthropics/skills/frontend-design");

    expect(command).toBe('bash -lc \'cd "$HOME" && acli skills-sh uninstall anthropics/skills/frontend-design\'');
  });

  it("rejects unsafe skills.sh IDs instead of interpolating shell syntax", () => {
    expect(() => buildSkillsshInstallCommand("owner/repo/skill; whoami")).toThrow("Invalid skills.sh skill ID");
  });

  it("keeps registry search as the direct command", () => {
    expect(buildSkillsshSearchCommand("frontend")).toBe("acli skills-sh search 'frontend' --sort-by installs");
  });

  it("keeps same-slug skills with different full IDs separate", () => {
    const first: InstalledSkill = {
      registry: "skills-sh",
      rawId: "team-a/tools/abc-analysis",
      slug: "abc-analysis",
      name: "ABC Analysis",
      registries: ["skills-sh"],
      sourceLabel: "skills.sh",
    };
    const second: InstalledSkill = {
      registry: "skills-sh",
      rawId: "team-b/research/abc-analysis",
      slug: "abc-analysis",
      name: "ABC Analysis",
      registries: ["skills-sh"],
      sourceLabel: "skills.sh",
    };

    expect(skillIdentity(first)).not.toBe(skillIdentity(second));
    expect(mergeInstalledSources([], [first, second])).toHaveLength(2);
  });
});

describe("domestic SkillHub command and response handling", () => {
  it("uses the domestic acli skills command family", () => {
    expect(buildSkillhubInstallCommand("builder-radar")).toBe("acli skills install 'builder-radar'");
    expect(buildSkillhubUninstallCommand("builder-radar")).toBe("acli skills uninstall 'builder-radar'");
    expect(buildSkillhubListCommand()).toBe("acli skills list");
  });

  it("maps SkillHub search and installed-list responses without merging by display name", () => {
    const search = parseSkillhubSearch(JSON.stringify({
      code: 0,
      data: {
        skills: [{
          category: "knowledge-management",
          description_zh: "帮助整理知识资料",
          downloads: 12_345,
          installs: 123,
          name: "Builder Radar",
          slug: "builder-radar",
          source: "community",
        }],
      },
    }));
    expect(search).toEqual([expect.objectContaining({
      registry: "skillhub",
      rawId: "builder-radar",
      description: "帮助整理知识资料",
      category: "knowledge-management",
      downloads: 12_345,
    })]);

    const installed = parseSkillhubList(JSON.stringify({
      success: true,
      data: { skills: [{ name: "builder-radar", display_name: "Builder Radar", version: "1.0.0" }] },
    }));
    expect(installed).toEqual([expect.objectContaining({
      registry: "skillhub",
      rawId: "builder-radar",
      sourceLabel: "SkillHub",
    })]);
  });
});

describe("skill popularity display", () => {
  it("uses installs above 20,000 for international registries", () => {
    expect(getPopularityTier({ registry: "skills-sh", installs: 20_001 })).toBe(1);
    expect(getPopularityTier({ registry: "skills-sh", installs: 20_000 })).toBeUndefined();
  });

  it("uses downloads above 10,000 for domestic SkillHub results", () => {
    expect(getPopularityTier({ registry: "skillhub", downloads: 10_001, installs: 0 })).toBe(1);
    expect(getPopularityTier({ registry: "skillhub", downloads: 10_000, installs: 99_999 })).toBeUndefined();
    expect(getPopularityTier({ registry: "skillhub", downloads: undefined })).toBeUndefined();
  });
});
