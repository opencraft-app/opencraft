import { describe, expect, it } from "vitest";

import {
  buildSkillhubInstallCommand,
  buildSkillhubListCommand,
  buildSkillhubUninstallCommand,
  createDomesticDataLayer,
  createLiveDataLayer,
  buildSkillsshInstallCommand,
  buildSkillsshSearchCommand,
  buildSkillsshUninstallCommand,
  getPopularityTier,
  mergeInstalledSources,
  parseInstallOk,
  parseUninstallOk,
  sortByPopular,
  skillIdentity,
  type Skill,
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
          iconUrl: "https://cdn.example.com/builder-radar.png",
          installs: 123,
          name: "Builder Radar",
          slug: "builder-radar",
          source: "clawhub",
        }],
      },
    }));
    expect(search).toEqual([expect.objectContaining({
      registry: "skillhub",
      rawId: "builder-radar",
      description: "帮助整理知识资料",
      category: "knowledge-management",
      downloads: 12_345,
      iconUrl: "https://cdn.example.com/builder-radar.png",
      sourceRegistry: "clawhub",
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

    const tableInstalled = parseSkillhubList([
      "┌───────────────┬─────────┐",
      "│ 名称          │ 版本    │",
      "├───────────────┼─────────┤",
      "│ builder-radar │ 1.0.0   │",
      "└───────────────┴─────────┘",
    ].join("\n"));
    expect(tableInstalled).toEqual([expect.objectContaining({ rawId: "builder-radar" })]);

    const numericIdOnly = parseSkillhubList(JSON.stringify({
      success: true,
      data: { skills: [{ id: "12345", name: "Builder Radar" }] },
    }));
    expect(numericIdOnly).toEqual([]);

    const englishSearch = parseSkillhubSearch(JSON.stringify({
      data: {
        skills: [{
          slug: "builder-radar",
          name: "构建雷达",
          displayNameEn: "Builder Radar",
          description_zh: "帮助整理知识资料",
          descriptionEn: "Helps organize project knowledge.",
        }],
      },
    }), "en");
    expect(englishSearch).toEqual([expect.objectContaining({
      name: "Builder Radar",
      description: "Helps organize project knowledge.",
    })]);
  });
});

describe("install and uninstall result handling", () => {
  const failedOutput = JSON.stringify({
    success: false,
    status: "installed",
    data: { status: "installed" },
    error: { code: "INSTALL_FAILED", message: "download failed" },
  });

  it("does not treat a failed envelope as successful when exit code is zero", () => {
    expect(parseInstallOk(failedOutput)).toBe(false);
    expect(parseUninstallOk(failedOutput)).toBe(false);
    expect(parseInstallOk(JSON.stringify({ success: true, data: { status: "installed" } }))).toBe(true);
    expect(parseUninstallOk(JSON.stringify({ success: true, data: { status: "uninstalled" } }))).toBe(true);
  });

  it("does not persist a false success for either registry data layer", async () => {
    const execDebugCommand = async () => ({
      status: "SUCCESS",
      exitCode: 0,
      output: failedOutput,
    });
    const globalSkill: Skill = {
      registry: "clawhub",
      rawId: "failed-skill",
      slug: "failed-skill",
      name: "Failed skill",
    };
    const domesticSkill: Skill = {
      registry: "skillhub",
      rawId: "failed-skill",
      slug: "failed-skill",
      name: "Failed skill",
    };

    const live = createLiveDataLayer("bot-1", execDebugCommand);
    expect(await live.install(globalSkill)).toEqual({ ok: false, message: failedOutput });
    expect(await live.uninstall(globalSkill)).toEqual({ ok: false, message: failedOutput });

    const domestic = createDomesticDataLayer("bot-1", execDebugCommand);
    expect(await domestic.install(domesticSkill)).toEqual({ ok: false, message: failedOutput });
    expect(await domestic.uninstall(domesticSkill)).toEqual({ ok: false, message: failedOutput });
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

  it("ranks domestic results by downloads while international results use installs", () => {
    const sorted = sortByPopular([
      { registry: "skillhub", rawId: "domestic-low", slug: "domestic-low", name: "Domestic low", installs: 99_999, downloads: 100 },
      { registry: "skillhub", rawId: "domestic-high", slug: "domestic-high", name: "Domestic high", installs: 1, downloads: 20_000 },
      { registry: "skills-sh", rawId: "global-high", slug: "global-high", name: "Global high", installs: 30_000, downloads: 1 },
    ]);

    expect(sorted.map((skill) => skill.name)).toEqual(["Global high", "Domestic high", "Domestic low"]);
  });
});
