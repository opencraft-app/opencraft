import { describe, expect, it } from "vitest";

import { buildHermesSkillDeleteCommand } from "@/lib/hermes-skills-client";

import {
  buildHermesSkillsListCommand,
  buildClawhubListCommand,
  buildSkillhubInstallCommand,
  buildSkillhubListCommand,
  buildSkillhubUninstallCommand,
  createDomesticDataLayer,
  createLiveDataLayer,
  buildSkillsshInstallCommand,
  buildSkillsshListCommand,
  buildSkillsshSearchCommand,
  buildSkillsshUninstallCommand,
  getPopularityTier,
  installSkillsSequentially,
  mergeInstalledWithHermes,
  mergeInstalledSources,
  parseHermesInstalledSkills,
  parseInstallOk,
  parseUninstallOk,
  sortByPopular,
  skillIdentity,
  uninstallSkillsSequentially,
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
      data: { skills: [{
        name: "builder-radar",
        display_name: "Builder Radar",
        iconUrl: "https://cdn.example.com/builder-radar.png",
        version: "1.0.0",
      }] },
    }));
    expect(installed).toEqual([expect.objectContaining({
      registry: "skillhub",
      rawId: "builder-radar",
      iconUrl: "https://cdn.example.com/builder-radar.png",
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

describe("Hermes native installed skills", () => {
  it("uses the Hermes CLI list command and maps native-only skills", () => {
    expect(buildHermesSkillsListCommand()).toContain("hermes_cli.main skills list");

    expect(parseHermesInstalledSkills([
      "│ Name │ Category │ Source │ Trust │ Status │",
      "│ finance-news │ research │ local │ yes │ installed │",
    ].join("\n"))).toEqual([
      expect.objectContaining({
        registry: "hermes",
        rawId: "finance-news",
        name: "Finance News",
        registries: ["hermes"],
        sourceLabel: "Hermes",
        uninstallable: true,
      }),
    ]);
  });

  it("merges a unique matching Hermes slug into a registry skill without duplicating it", () => {
    const registrySkill: InstalledSkill = {
      registry: "skills-sh",
      rawId: "team/repo/finance-news",
      slug: "finance-news",
      name: "Finance News",
      registries: ["skills-sh"],
      sourceLabel: "skills.sh",
    };
    const [hermesSkill] = parseHermesInstalledSkills("finance-news");

    expect(mergeInstalledWithHermes([registrySkill], hermesSkill ? [hermesSkill] : [])).toEqual([
      expect.objectContaining({
        rawId: "team/repo/finance-news",
        registries: ["skills-sh", "hermes"],
        uninstallable: true,
      }),
    ]);
  });

  it("keeps native-only skills alongside registry-installed skills", () => {
    const registrySkill: InstalledSkill = {
      registry: "skillhub",
      rawId: "builder-radar",
      slug: "builder-radar",
      name: "Builder Radar",
      registries: ["skillhub"],
      sourceLabel: "SkillHub",
    };
    const nativeSkills = parseHermesInstalledSkills("finance-news");

    expect(mergeInstalledWithHermes([registrySkill], nativeSkills).map((skill) => skill.rawId)).toEqual([
      "builder-radar",
      "finance-news",
    ]);
  });

  it("queries and merges Hermes-native skills in both international and domestic data layers", async () => {
    const commands: string[] = [];
    const execDebugCommand = async (_botId: string, command: string) => {
      commands.push(command);
      const output = command === buildHermesSkillsListCommand()
        ? "│ Name │ Category │ Source │ Trust │ Status │\n│ finance-news │ research │ local │ yes │ installed │"
        : command === buildClawhubListCommand()
          ? JSON.stringify({ success: true, data: { skills: [{ slug: "react", displayName: "React" }] } })
          : command === buildSkillsshListCommand()
            ? JSON.stringify({ success: true, data: { skills: [] } })
            : JSON.stringify({ success: true, data: { skills: [{ name: "builder-radar" }] } });
      return { status: "SUCCESS", exitCode: 0, output };
    };

    await expect(createLiveDataLayer("bot-1", execDebugCommand).listInstalled()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rawId: "react" }),
        expect.objectContaining({ rawId: "finance-news", registry: "hermes" }),
      ]),
    );
    await expect(createDomesticDataLayer("bot-1", execDebugCommand).listInstalled()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rawId: "builder-radar" }),
        expect.objectContaining({ rawId: "finance-news", registry: "hermes" }),
      ]),
    );
    expect(commands.filter((command) => command === buildHermesSkillsListCommand())).toHaveLength(2);
  });

  it("really deletes Hermes-native skill directories in both data layers", async () => {
    const commands: string[] = [];
    const execDebugCommand = async (_botId: string, command: string) => {
      commands.push(command);
      return { status: "SUCCESS", exitCode: 0, output: "" };
    };
    const nativeSkill: InstalledSkill = {
      registry: "hermes",
      rawId: "finance-news",
      slug: "finance-news",
      name: "Finance News",
      registries: ["hermes"],
      sourceLabel: "Hermes",
      uninstallable: true,
    };

    await expect(createLiveDataLayer("bot-1", execDebugCommand).uninstall(nativeSkill)).resolves.toEqual({ ok: true });
    await expect(createDomesticDataLayer("bot-1", execDebugCommand).uninstall(nativeSkill)).resolves.toEqual({ ok: true });
    expect(commands).toEqual([
      buildHermesSkillDeleteCommand("finance-news"),
      buildHermesSkillDeleteCommand("finance-news"),
    ]);
  });
});

describe("batch skill installation", () => {
  it("installs selected skills sequentially and reports partial failures", async () => {
    const skills: Skill[] = [
      { registry: "clawhub", rawId: "first", slug: "first", name: "First" },
      { registry: "skills-sh", rawId: "team/repo/second", slug: "second", name: "Second" },
      { registry: "skillhub", rawId: "third", slug: "third", name: "Third" },
    ];
    const calls: string[] = [];
    const dataLayer = {
      install: async (skill: Skill) => {
        calls.push(skill.rawId);
        return skill.rawId.includes("second")
          ? { ok: false, message: "download failed" }
          : { ok: true };
      },
    };

    const result = await installSkillsSequentially(dataLayer, skills);

    expect(calls).toEqual(["first", "team/repo/second", "third"]);
    expect(result.succeeded.map((skill) => skill.rawId)).toEqual(["first", "third"]);
    expect(result.failed).toEqual([{ skill: skills[1], message: "download failed" }]);
  });

  it("uninstalls selected skills sequentially and keeps failures with their messages", async () => {
    const skills: InstalledSkill[] = [
      {
        registry: "skillhub",
        rawId: "first",
        slug: "first",
        name: "First",
        registries: ["skillhub"],
        sourceLabel: "SkillHub",
      },
      {
        registry: "hermes",
        rawId: "second",
        slug: "second",
        name: "Second",
        registries: ["hermes"],
        sourceLabel: "Hermes",
      },
      {
        registry: "clawhub",
        rawId: "third",
        slug: "third",
        name: "Third",
        registries: ["clawhub"],
        sourceLabel: "ClawHub",
      },
    ];
    const calls: string[] = [];
    const dataLayer = {
      uninstall: async (skill: Skill) => {
        calls.push(skill.rawId);
        if (skill.rawId === "second") return { ok: false, message: "still in use" };
        if (skill.rawId === "third") throw new Error("command unavailable");
        return { ok: true };
      },
    };

    const result = await uninstallSkillsSequentially(dataLayer, skills);

    expect(calls).toEqual(["first", "second", "third"]);
    expect(result.succeeded).toEqual([skills[0]]);
    expect(result.failed).toEqual([
      { skill: skills[1], message: "still in use" },
      { skill: skills[2], message: "command unavailable" },
    ]);
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
