import { describe, expect, it } from "vitest";

import { buildHermesSkillDeleteCommand } from "@/lib/hermes-skills-client";

import {
  buildHermesSkillsListCommand,
  buildClawhubBatchInstallCommand,
  buildClawhubListCommand,
  buildClawhubSearchCommand,
  buildClawhubUninstallCommand,
  buildSkillhubBatchInstallCommand,
  buildSkillhubInstallCommand,
  buildSkillhubListCommand,
  buildSkillhubUninstallCommand,
  createDomesticDataLayer,
  createLiveDataLayer,
  buildSkillsshBatchInstallCommand,
  buildSkillsshInstallCommand,
  buildSkillsshListCommand,
  buildSkillsshSearchCommand,
  buildSkillsshUninstallCommand,
  getSkillSourceUrl,
  getPopularityTier,
  installSkillsInBatch,
  installSkillsSequentially,
  installSkillsWithNativeBatch,
  mergeInstalledWithHermes,
  mergeInstalledSources,
  parseHermesInstalledSkills,
  parseInstallOk,
  parseUninstallOk,
  sortByPopular,
  skillIdentity,
  type Skill,
  type InstalledSkill,
} from "./skill-registries";
import { parseSkillhubList, parseSkillhubSearch } from "./skill-registries";

describe("skills.sh command builders", () => {
  it("derives canonical marketplace detail links only from reliable result identity", () => {
    const skillsShSkill: Skill = {
      registry: "skills-sh",
      rawId: "anthropics/skills/frontend-design",
      slug: "frontend-design",
      name: "Frontend Design",
    };
    const clawhubSkill: Skill = {
      registry: "clawhub",
      rawId: "akshare-stock",
      slug: "akshare-stock",
      name: "AkShare Stock",
      author: "mbpz",
    };
    const clawhubSkillWithoutAuthor: Skill = {
      ...clawhubSkill,
      author: undefined,
    };

    expect(getSkillSourceUrl(skillsShSkill)).toBe("https://skills.sh/anthropics/skills/frontend-design");
    expect(getSkillSourceUrl(clawhubSkill)).toBe("https://clawhub.ai/mbpz/skills/akshare-stock");
    expect(getSkillSourceUrl(clawhubSkillWithoutAuthor)).toBeUndefined();
    expect(getSkillSourceUrl({ ...skillsShSkill, rawId: "stock" })).toBeUndefined();
    expect(getSkillSourceUrl({ ...skillsShSkill, rawId: "owner//stock" })).toBeUndefined();
  });

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

  it("merges matching marketplace records only when Hermes confirms one runtime skill", () => {
    const clawhubSkill: InstalledSkill = {
      registry: "clawhub",
      rawId: "okx-sentiment-tracker",
      slug: "okx-sentiment-tracker",
      name: "OKX Sentiment Tracker",
      registries: ["clawhub"],
      sourceLabel: "ClawHub",
      sourceUrls: {
        clawhub: "https://clawhub.ai/example-owner/skills/okx-sentiment-tracker",
      },
    };
    const skillsshSkill: InstalledSkill = {
      registry: "skills-sh",
      rawId: "okx/agent-skills/okx-sentiment-tracker",
      slug: "okx-sentiment-tracker",
      name: "okx-sentiment-tracker",
      registries: ["skills-sh"],
      sourceLabel: "skills.sh",
      sourceUrls: {
        "skills-sh": "https://skills.sh/okx/agent-skills/okx-sentiment-tracker",
      },
    };
    const hermesSkills = parseHermesInstalledSkills("okx-sentiment-tracker");

    const marketplaceInstalled = mergeInstalledSources([clawhubSkill], [skillsshSkill]);
    expect(marketplaceInstalled).toHaveLength(2);

    const installed = mergeInstalledWithHermes(marketplaceInstalled, hermesSkills);

    expect(installed).toHaveLength(1);
    expect(installed[0]).toEqual(expect.objectContaining({
      registry: "clawhub",
      rawId: "okx-sentiment-tracker",
      registries: ["clawhub", "skills-sh", "hermes"],
      sourceLabel: "ClawHub / skills.sh / Hermes",
      uninstallTargets: [
        { registry: "clawhub", rawId: "okx-sentiment-tracker" },
        { registry: "skills-sh", rawId: "okx/agent-skills/okx-sentiment-tracker" },
      ],
      sourceUrls: {
        clawhub: "https://clawhub.ai/example-owner/skills/okx-sentiment-tracker",
        "skills-sh": "https://skills.sh/okx/agent-skills/okx-sentiment-tracker",
      },
    }));
  });

  it("uninstalls only the selected registry record and verifies that it disappeared", async () => {
    const commands: string[] = [];
    const execDebugCommand = async (_botId: string, command: string) => {
      commands.push(command);
      const output = command === buildSkillsshUninstallCommand("team/repo/shared-skill")
        ? JSON.stringify({ success: true, data: { status: "uninstalled" } })
        : command === buildHermesSkillsListCommand()
          ? ""
          : JSON.stringify({ success: true, data: { skills: [] } });
      return {
        status: "SUCCESS",
        exitCode: 0,
        output,
      };
    };
    const installedSkill: InstalledSkill = {
      registry: "skills-sh",
      rawId: "team/repo/shared-skill",
      slug: "shared-skill",
      name: "Shared Skill",
      registries: ["skills-sh"],
      sourceLabel: "skills.sh",
    };

    await expect(createLiveDataLayer("bot-1", execDebugCommand).uninstall(installedSkill)).resolves.toEqual({ ok: true });
    expect(commands).toEqual([
      buildSkillsshUninstallCommand("team/repo/shared-skill"),
      buildClawhubListCommand(),
      buildSkillsshListCommand(),
      buildHermesSkillsListCommand(),
    ]);
  });

  it("stops after the first uninstall candidate removes a merged runtime skill", async () => {
    const commands: string[] = [];
    const execDebugCommand = async (_botId: string, command: string) => {
      commands.push(command);
      const output = command === buildClawhubUninstallCommand("documentation-writer")
        ? JSON.stringify({ success: true, data: { status: "uninstalled" } })
        : command === buildSkillsshUninstallCommand("github/awesome-copilot/documentation-writer")
          ? JSON.stringify({
              success: false,
              error: { code: "SKILLS_SH_NOT_INSTALLED", message: "未找到已安装的技能" },
            })
          : command === buildHermesSkillsListCommand()
            ? ""
            : JSON.stringify({ success: true, data: { skills: [] } });
      return {
        status: command.includes("skills-sh uninstall") ? "FAILED" : "SUCCESS",
        exitCode: command.includes("skills-sh uninstall") ? 1 : 0,
        output,
      };
    };
    const installedSkill: InstalledSkill = {
      registry: "clawhub",
      rawId: "documentation-writer",
      slug: "documentation-writer",
      name: "Documentation Writer",
      registries: ["clawhub", "skills-sh", "hermes"],
      sourceLabel: "ClawHub / skills.sh / Hermes",
      uninstallTargets: [
        { registry: "clawhub", rawId: "documentation-writer" },
        { registry: "skills-sh", rawId: "github/awesome-copilot/documentation-writer" },
      ],
    };

    await expect(createLiveDataLayer("bot-1", execDebugCommand).uninstall(installedSkill)).resolves.toEqual({ ok: true });
    expect(commands).toEqual([
      buildClawhubUninstallCommand("documentation-writer"),
      buildClawhubListCommand(),
      buildSkillsshListCommand(),
      buildHermesSkillsListCommand(),
    ]);
  });

  it("tries the next uninstall candidate when the first source reports not installed", async () => {
    const commands: string[] = [];
    const execDebugCommand = async (_botId: string, command: string) => {
      commands.push(command);
      const isMissingSkillssh = command === buildSkillsshUninstallCommand(
        "github/awesome-copilot/documentation-writer",
      );
      const output = isMissingSkillssh
        ? JSON.stringify({
            success: false,
            error: { code: "SKILLS_SH_NOT_INSTALLED", message: "未找到已安装的技能" },
          })
        : command === buildClawhubUninstallCommand("documentation-writer")
          ? JSON.stringify({ success: true, data: { status: "uninstalled" } })
          : command === buildHermesSkillsListCommand()
            ? ""
            : JSON.stringify({ success: true, data: { skills: [] } });
      return {
        status: isMissingSkillssh ? "FAILED" : "SUCCESS",
        exitCode: isMissingSkillssh ? 1 : 0,
        output,
      };
    };
    const installedSkill: InstalledSkill = {
      registry: "skills-sh",
      rawId: "github/awesome-copilot/documentation-writer",
      slug: "documentation-writer",
      name: "Documentation Writer",
      registries: ["skills-sh", "clawhub", "hermes"],
      sourceLabel: "skills.sh / ClawHub / Hermes",
      uninstallTargets: [
        { registry: "skills-sh", rawId: "github/awesome-copilot/documentation-writer" },
        { registry: "clawhub", rawId: "documentation-writer" },
      ],
    };

    await expect(createLiveDataLayer("bot-1", execDebugCommand).uninstall(installedSkill)).resolves.toEqual({ ok: true });
    expect(commands).toEqual([
      buildSkillsshUninstallCommand("github/awesome-copilot/documentation-writer"),
      buildClawhubUninstallCommand("documentation-writer"),
      buildClawhubListCommand(),
      buildSkillsshListCommand(),
      buildHermesSkillsListCommand(),
    ]);
  });
});

describe("domestic SkillHub command and response handling", () => {
  it("uses the domestic acli skills command family", () => {
    expect(buildSkillhubInstallCommand("builder-radar")).toBe("acli skills install 'builder-radar'");
    expect(buildSkillhubUninstallCommand("builder-radar")).toBe("acli skills uninstall 'builder-radar'");
    expect(buildSkillhubListCommand()).toBe("acli skills list");
  });

  it("treats every domestic SkillHub API result as SkillHub", () => {
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
    })]);
    expect(search[0]).not.toHaveProperty("sourceRegistry");

    const installed = parseSkillhubList(JSON.stringify({
      success: true,
      data: { skills: [{
        name: "builder-radar",
        display_name: "Builder Radar",
        category: "productivity",
        iconUrl: "https://cdn.example.com/builder-radar.png",
        version: "1.0.0",
      }] },
    }));
    expect(installed).toEqual([expect.objectContaining({
      registry: "skillhub",
      rawId: "builder-radar",
      category: "productivity",
      iconUrl: "https://cdn.example.com/builder-radar.png",
      sourceLabel: "SkillHub",
    })]);

    const groupedInstalled = parseSkillhubList(JSON.stringify({
      success: true,
      data: {
        skills: [{
          id: "skill_91fca7e4",
          name: "humanizer",
          display_name: "humanizer",
          relative_path: "creative/humanizer",
          category: "creative",
          version: "2.5.1",
          instances: [{
            id: "skill_91fca7e4",
            name: "humanizer",
            display_name: "humanizer",
            relative_path: "creative/humanizer",
            source: "builtin",
            version: "2.5.1",
          }, {
            id: "skill_e95600124c0d7729fa4d",
            name: "humanizer",
            display_name: "humanizer",
            relative_path: "unclecheng-reduce-ai-perception-v2",
            source: "builtin",
            version: "4.1.0",
          }],
        }],
      },
    }));
    expect(groupedInstalled).toHaveLength(2);
    expect(groupedInstalled).toEqual(expect.arrayContaining([
      expect.objectContaining({
        rawId: "skill_91fca7e4",
        slug: "creative/humanizer",
        name: "humanizer",
        category: "creative",
        version: "2.5.1",
      }),
      expect.objectContaining({
        rawId: "skill_e95600124c0d7729fa4d",
        slug: "unclecheng-reduce-ai-perception-v2",
        name: "humanizer",
        category: "creative",
        version: "4.1.0",
      }),
    ]));
    expect(
      groupedInstalled.find((skill) => skill.slug === "unclecheng-reduce-ai-perception-v2")?.nativeAliases,
    ).toEqual(expect.arrayContaining([
      "humanizer",
      "skill_e95600124c0d7729fa4d",
      "unclecheng-reduce-ai-perception-v2",
    ]));

    const tableInstalled = parseSkillhubList([
      "┌───────────────┬──────────────┬─────────┐",
      "│ 名称          │ 分类         │ 版本    │",
      "├───────────────┼──────────────┼─────────┤",
      "│ builder-radar │ productivity │ 1.0.0   │",
      "└───────────────┴──────────────┴─────────┘",
    ].join("\n"));
    expect(tableInstalled).toEqual([expect.objectContaining({
      rawId: "builder-radar",
      category: "productivity",
      version: "1.0.0",
    })]);

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
        category: "research",
        status: "installed",
        registries: ["hermes"],
        nativeSource: "local",
        sourceLabel: "本地安装",
        uninstallable: true,
      }),
    ]);
  });

  it("keeps builtin Hermes skills distinct from local skills", () => {
    expect(parseHermesInstalledSkills([
      "│ Name │ Category │ Source │ Trust │ Status │",
      "│ plan │ productivity │ builtin │ builtin │ enabled │",
    ].join("\n"))).toEqual([
      expect.objectContaining({
        rawId: "plan",
        category: "productivity",
        status: "enabled",
        nativeSource: "builtin",
        sourceLabel: "系统预置",
        uninstallable: false,
      }),
    ]);
  });

  it("maps source-less Hermes skills to other", () => {
    expect(parseHermesInstalledSkills("builder-radar")).toEqual([
      expect.objectContaining({
        rawId: "builder-radar",
        nativeSource: "other",
        sourceLabel: "其他",
      }),
    ]);
  });

  it("maps known Hermes source labels and preserves unknown source text", () => {
    expect(parseHermesInstalledSkills([
      "│ Name │ Category │ Source │ Status │",
      "│ claw-tool │ utility │ clawhub │ enabled │",
      "│ custom-tool │ utility │ custom-channel │ enabled │",
    ].join("\n"))).toEqual([
      expect.objectContaining({ rawId: "claw-tool", sourceLabel: "ClawHub" }),
      expect.objectContaining({ rawId: "custom-tool", sourceLabel: "custom-channel" }),
    ]);
  });

  it("maps non-bundled skills stored under the Hermes skills root to other", () => {
    expect(parseHermesInstalledSkills(
      "│ Name │ Category │ Source │ Status │\n"
      + "│ find-skills │ utility │ local │ enabled │\n"
      + "\n__HERMES_BUNDLED_MANIFEST__\n"
      + "\n__HERMES_SKILLS_ROOT__\n"
      + "/home/agentuser/.hermes/skills/find-skills/SKILL.md\n",
    )).toEqual([
      expect.objectContaining({
        rawId: "find-skills",
        nativeSource: "other",
        sourceLabel: "其他",
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

  it("keeps same-slug records from one marketplace separate when Hermes cannot identify the owner", () => {
    const registrySkills: InstalledSkill[] = [{
      registry: "skills-sh",
      rawId: "team-a/repository/shared-skill",
      slug: "shared-skill",
      name: "Team A Shared Skill",
      registries: ["skills-sh"],
      sourceLabel: "skills.sh",
    }, {
      registry: "skills-sh",
      rawId: "team-b/repository/shared-skill",
      slug: "shared-skill",
      name: "Team B Shared Skill",
      registries: ["skills-sh"],
      sourceLabel: "skills.sh",
    }];
    const hermesSkills = parseHermesInstalledSkills("shared-skill");

    expect(mergeInstalledWithHermes(registrySkills, hermesSkills)).toEqual([
      expect.objectContaining({
        registry: "skills-sh",
        rawId: "team-a/repository/shared-skill",
        registries: ["skills-sh"],
      }),
      expect.objectContaining({
        registry: "skills-sh",
        rawId: "team-b/repository/shared-skill",
        registries: ["skills-sh"],
      }),
    ]);
  });

  it.each([
    {
      aliasField: "display_name",
      marketplaceSlug: "quant-backtest-strategy",
      nativeSlug: "onequant-backtest",
    },
    {
      aliasField: "displayName",
      marketplaceSlug: "valuation-analysis",
      nativeSlug: "股票价值投资分析 (valuation-analysis)",
    },
  ])("merges SkillHub alias $marketplaceSlug with Hermes native slug $nativeSlug", ({
    aliasField,
    marketplaceSlug,
    nativeSlug,
  }) => {
    const registrySkills = parseSkillhubList(JSON.stringify({
      success: true,
      data: {
        skills: [{
          name: marketplaceSlug,
          [aliasField]: nativeSlug,
        }],
      },
    }));
    const hermesSkills = parseHermesInstalledSkills(nativeSlug);

    expect(mergeInstalledWithHermes(registrySkills, hermesSkills)).toEqual([
      expect.objectContaining({
        registry: "skillhub",
        rawId: marketplaceSlug,
        registries: ["skillhub", "hermes"],
      }),
    ]);
  });

  it("keeps an unrelated Hermes skill when no explicit SkillHub alias matches", () => {
    const registrySkills = parseSkillhubList(JSON.stringify({
      success: true,
      data: {
        skills: [{
          slug: "different-marketplace-skill",
          display_name: "different-native-name",
        }],
      },
    }));
    const hermesSkills = parseHermesInstalledSkills("onequant-backtest");

    expect(mergeInstalledWithHermes(registrySkills, hermesSkills)).toHaveLength(2);
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
      expect.objectContaining({
        failedSources: [],
        skills: expect.arrayContaining([
          expect.objectContaining({ rawId: "react" }),
          expect.objectContaining({ rawId: "finance-news", registry: "hermes" }),
        ]),
      }),
    );
    await expect(createDomesticDataLayer("bot-1", execDebugCommand).listInstalled()).resolves.toEqual(
      expect.objectContaining({
        failedSources: [],
        skills: expect.arrayContaining([
          expect.objectContaining({ rawId: "builder-radar" }),
          expect.objectContaining({ rawId: "finance-news", registry: "hermes" }),
        ]),
      }),
    );
    expect(commands.filter((command) => command === buildHermesSkillsListCommand())).toHaveLength(2);
  });

  it("marks an ambiguous Hermes row as unavailable when its registry list fails", async () => {
    const execDebugCommand = async (_botId: string, command: string) => {
      if (command === buildSkillhubListCommand()) {
        return { status: "FAILED", exitCode: 1, output: "", stderr: "registry unavailable" };
      }
      return { status: "SUCCESS", exitCode: 0, output: "builder-radar" };
    };

    await expect(createDomesticDataLayer("bot-1", execDebugCommand).listInstalled()).resolves.toEqual({
      failedSources: ["skillhub"],
      skills: [expect.objectContaining({
        rawId: "builder-radar",
        sourceLabel: "来源暂不可用",
        sourceUncertain: true,
        uninstallable: false,
      })],
    });
  });

  it("reports failure when an uninstalled marketplace skill remains in Hermes", async () => {
    const execDebugCommand = async (_botId: string, command: string) => {
      const output = command === buildSkillhubUninstallCommand("builder-radar")
        ? JSON.stringify({ success: true, data: { status: "uninstalled" } })
        : command === buildSkillhubListCommand()
          ? JSON.stringify({ success: true, data: { skills: [] } })
          : "builder-radar";
      return { status: "SUCCESS", exitCode: 0, output };
    };
    const skill: InstalledSkill = {
      registry: "skillhub",
      rawId: "builder-radar",
      slug: "builder-radar",
      name: "Builder Radar",
      registries: ["skillhub", "hermes"],
      sourceLabel: "SkillHub",
    };

    await expect(createDomesticDataLayer("bot-1", execDebugCommand).uninstall(skill)).resolves.toEqual({
      ok: false,
      message: "卸载后技能仍然存在，请重试",
    });
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
      buildClawhubListCommand(),
      buildSkillsshListCommand(),
      buildHermesSkillsListCommand(),
      buildHermesSkillDeleteCommand("finance-news"),
      buildSkillhubListCommand(),
      buildHermesSkillsListCommand(),
    ]);
  });
});

describe("batch skill installation", () => {
  it("allows a consumer-specific batch command and exposes sequential fallback", async () => {
    const skills: Skill[] = [
      { registry: "skillhub", rawId: "market-data", slug: "market-data", name: "Market Data" },
    ];
    const commands: string[] = [];
    let fellBack = false;
    const execDebugCommandStream = async (_botId: string, command: string) => {
      commands.push(command);
      return { status: "FAILED", exitCode: 1, output: 'unknown command "batch-install"' };
    };

    const result = await installSkillsWithNativeBatch(
      "bot-1",
      execDebugCommandStream,
      async () => ({ ok: true }),
      skills,
      undefined,
      {
        buildBatchCommand: () => "custom skill-package batch command",
        onSequentialFallback: () => {
          fellBack = true;
        },
      },
    );

    expect(commands).toEqual(["custom skill-package batch command"]);
    expect(fellBack).toBe(true);
    expect(result).toEqual({ succeeded: skills, failed: [], skipped: [] });
  });

  it("reports skills omitted from an otherwise supported native batch response", async () => {
    const skills: Skill[] = [
      { registry: "skillhub", rawId: "market-data", slug: "market-data", name: "Market Data" },
      { registry: "skillhub", rawId: "backtest-engine", slug: "backtest-engine", name: "Backtest Engine" },
    ];
    const incompleteRuns: string[][] = [];
    const execDebugCommandStream = async (
      _botId: string,
      _command: string,
      onChunk: (event: { stream: string; chunk: string }) => void,
    ) => {
      onChunk({
        stream: "stdout",
        chunk: '{"event":"summary","results":[{"name":"market-data","status":"installed"}]}\n',
      });
      return { status: "SUCCESS", exitCode: 0, output: "" };
    };

    const result = await installSkillsWithNativeBatch(
      "bot-1",
      execDebugCommandStream,
      async () => ({ ok: true }),
      skills,
      undefined,
      {
        onIncompleteResults: (_registry, incompleteSkills) => {
          incompleteRuns.push(incompleteSkills.map((skill) => skill.rawId));
        },
      },
    );

    expect(incompleteRuns).toEqual([["backtest-engine"]]);
    expect(result).toEqual({
      succeeded: [skills[0]],
      failed: [{ skill: skills[1], message: "未收到技能安装结果" }],
      skipped: [],
    });
  });

  it("keeps summary results aligned after an earlier progress event", async () => {
    const skills: Skill[] = [
      { registry: "clawhub", rawId: "first", slug: "first", name: "First" },
      { registry: "clawhub", rawId: "second", slug: "second", name: "Second" },
    ];
    const execDebugCommand = async () => ({ status: "SUCCESS", exitCode: 0, output: "" });
    const execDebugCommandStream = async (
      _botId: string,
      _command: string,
      onChunk: (event: { stream: string; chunk: string }) => void,
    ) => {
      onChunk({ stream: "stdout", chunk: '{"event":"progress","slug":"first","status":"installed"}\n' });
      onChunk({
        stream: "stdout",
        chunk: '{"event":"summary","results":[{"slug":"first","status":"installed"},{"slug":"second","status":"failed","message":"download failed"}]}\n',
      });
      return { status: "SUCCESS", exitCode: 0, output: "" };
    };
    const dataLayer = createLiveDataLayer("bot-1", execDebugCommand, execDebugCommandStream);

    const result = await installSkillsInBatch(dataLayer, skills);

    expect(result.succeeded).toEqual([skills[0]]);
    expect(result.failed).toEqual([{ skill: skills[1], message: "download failed" }]);
  });

  it("builds the three native ACLI batch commands from the backend contract", () => {
    expect(buildClawhubBatchInstallCommand(["world-model", "hello-world-skill"]))
      .toBe("acli clawhub batch-install --wait=true 'world-model hello-world-skill'");
    expect(buildSkillsshBatchInstallCommand([
      "kostja94/marketing-skills/masonry",
      "sickn33/antigravity-awesome-skills/agent-squad",
    ])).toBe(
      "bash -lc 'cd \"$HOME\" && acli skills-sh batch-install --wait=true '\\''kostja94/marketing-skills/masonry sickn33/antigravity-awesome-skills/agent-squad'\\'''",
    );
    expect(buildSkillhubBatchInstallCommand(["react", "react-email-skills", "react-performance"]))
      .toBe("acli skills batch-install --wait=true 'react react-email-skills react-performance'");
  });

  it("streams skills.sh progress in order and preserves backend partial-failure details", async () => {
    const skills: Skill[] = [
      {
        registry: "skills-sh",
        rawId: "kostja94/marketing-skills/masonry",
        slug: "masonry",
        name: "Masonry",
      },
      {
        registry: "skills-sh",
        rawId: "sickn33/antigravity-awesome-skills/agent-squad",
        slug: "agent-squad",
        name: "Agent Squad",
      },
    ];
    const commands: string[] = [];
    const execDebugCommand = async () => ({ status: "SUCCESS", exitCode: 0, output: "" });
    const execDebugCommandStream = async (
      _botId: string,
      command: string,
      onChunk: (event: { stream: string; chunk: string }) => void,
    ) => {
      commands.push(command);
      onChunk({
        stream: "stdout",
        chunk: '{"event":"progress","index":1,"total":2,"slug":"kostja94/marketing-skills/masonry","status":"failed","error_code":"SKILLS_SH_SKILL_NOT_IN_REPO",',
      });
      onChunk({
        stream: "stdout",
        chunk: '"message":"技能已删除或改名"}\n{"event":"progress","index":2,"total":2,"slug":"sickn33/antigravity-awesome-skills/agent-squad","status":"installed","id":"sickn33/antigravity-awesome-skills/agent-squad"}\n',
      });
      onChunk({
        stream: "stdout",
        chunk: '{"event":"summary","total":2,"succeeded":1,"failed":1,"gateway_restarted":false}\n',
      });
      return { status: "SUCCESS", exitCode: 0, output: "" };
    };
    const progress: string[] = [];
    const dataLayer = createLiveDataLayer("bot-1", execDebugCommand, execDebugCommandStream);

    const result = await installSkillsInBatch(dataLayer, skills, ({ index, skill, status, message }) => {
      progress.push(`${index}:${skill.rawId}:${status}:${message ?? ""}`);
    });

    expect(commands).toEqual([buildSkillsshBatchInstallCommand(skills.map((skill) => skill.rawId))]);
    expect(progress).toEqual([
      "1:kostja94/marketing-skills/masonry:installing:",
      "1:kostja94/marketing-skills/masonry:failed:技能已删除或改名",
      "2:sickn33/antigravity-awesome-skills/agent-squad:installing:",
      "2:sickn33/antigravity-awesome-skills/agent-squad:succeeded:",
    ]);
    expect(result.succeeded).toEqual([skills[1]]);
    expect(result.failed).toEqual([{ skill: skills[0], message: "技能已删除或改名" }]);
    expect(result.skipped).toEqual([]);
  });

  it("uses SkillHub native batch output when the stream is only available in the final response", async () => {
    const skills: Skill[] = [
      { registry: "skillhub", rawId: "react", slug: "react", name: "React" },
      { registry: "skillhub", rawId: "react-performance", slug: "react-performance", name: "React Performance" },
    ];
    const commands: string[] = [];
    const execDebugCommand = async () => ({ status: "SUCCESS", exitCode: 0, output: "" });
    const execDebugCommandStream = async (_botId: string, command: string) => {
      commands.push(command);
      return {
        status: "SUCCESS",
        exitCode: 0,
        output: [
          '{"event":"progress","index":1,"total":2,"name":"react","status":"installed","id":"react"}',
          '{"event":"progress","index":2,"total":2,"name":"react-performance","status":"installed","id":"react-performance"}',
          '{"event":"summary","total":2,"succeeded":2,"failed":0,"gateway_restarted":false}',
        ].join("\n"),
      };
    };
    const dataLayer = createDomesticDataLayer("bot-1", execDebugCommand, "zh", execDebugCommandStream);

    const result = await installSkillsInBatch(dataLayer, skills);

    expect(commands).toEqual([buildSkillhubBatchInstallCommand(skills.map((skill) => skill.rawId))]);
    expect(result.succeeded).toEqual(skills);
    expect(result.failed).toEqual([]);
  });

  it("falls back to sequential installs when an older ACLI lacks batch-install", async () => {
    const skills: Skill[] = [
      { registry: "clawhub", rawId: "world-model", slug: "world-model", name: "World Model" },
      { registry: "clawhub", rawId: "hello-world-skill", slug: "hello-world-skill", name: "Hello World" },
    ];
    const commands: string[] = [];
    const execDebugCommand = async (_botId: string, command: string) => {
      commands.push(command);
      return {
        status: "SUCCESS",
        exitCode: 0,
        output: JSON.stringify({ success: true, data: { status: "installed" } }),
      };
    };
    const execDebugCommandStream = async (_botId: string, command: string) => {
      commands.push(command);
      return { status: "FAILED", exitCode: 1, output: 'unknown command "batch-install"' };
    };
    const dataLayer = createLiveDataLayer("bot-1", execDebugCommand, execDebugCommandStream);

    const result = await installSkillsInBatch(dataLayer, skills);

    expect(commands).toEqual([
      buildClawhubBatchInstallCommand(skills.map((skill) => skill.rawId)),
      "acli clawhub install 'world-model'",
      "acli clawhub install 'hello-world-skill'",
    ]);
    expect(result.succeeded).toEqual(skills);
    expect(result.failed).toEqual([]);
  });

  it("cancels remaining registry runs after the active native batch command completes", async () => {
    const skills: Skill[] = [
      { registry: "clawhub", rawId: "world-model", slug: "world-model", name: "World Model" },
      { registry: "skillhub", rawId: "react", slug: "react", name: "React" },
    ];
    const commands: string[] = [];
    let cancelled = false;
    const execDebugCommand = async () => ({ status: "SUCCESS", exitCode: 0, output: "" });
    const execDebugCommandStream = async (
      _botId: string,
      command: string,
      onChunk: (event: { stream: string; chunk: string }) => void,
    ) => {
      commands.push(command);
      onChunk({
        stream: "stdout",
        chunk: '{"event":"progress","index":1,"total":1,"slug":"world-model","status":"installed"}\n',
      });
      cancelled = true;
      return { status: "SUCCESS", exitCode: 0, output: "" };
    };
    const dataLayer = createLiveDataLayer("bot-1", execDebugCommand, execDebugCommandStream);

    const result = await installSkillsInBatch(dataLayer, skills, undefined, {
      shouldCancel: () => cancelled,
    });

    expect(commands).toEqual([buildClawhubBatchInstallCommand(["world-model"])]);
    expect(result.succeeded).toEqual([skills[0]]);
    expect(result.failed).toEqual([]);
    expect(result.skipped).toEqual([skills[1]]);
  });

  it("installs selected skills sequentially and reports partial failures", async () => {
    const skills: Skill[] = [
      { registry: "clawhub", rawId: "first", slug: "first", name: "First" },
      { registry: "skills-sh", rawId: "team/repo/second", slug: "second", name: "Second" },
      { registry: "skillhub", rawId: "third", slug: "third", name: "Third" },
    ];
    const calls: string[] = [];
    const progress: string[] = [];
    const dataLayer = {
      install: async (skill: Skill) => {
        calls.push(skill.rawId);
        return skill.rawId.includes("second")
          ? { ok: false, message: "download failed" }
          : { ok: true };
      },
    };

    const result = await installSkillsSequentially(dataLayer, skills, ({ index, total, skill, status, message }) => {
      progress.push(`${index}/${total}:${skill.rawId}:${status}:${message ?? ""}`);
    });

    expect(calls).toEqual(["first", "team/repo/second", "third"]);
    expect(progress).toEqual([
      "1/3:first:installing:",
      "1/3:first:succeeded:",
      "2/3:team/repo/second:installing:",
      "2/3:team/repo/second:failed:download failed",
      "3/3:third:installing:",
      "3/3:third:succeeded:",
    ]);
    expect(result.succeeded.map((skill) => skill.rawId)).toEqual(["first", "third"]);
    expect(result.failed).toEqual([{ skill: skills[1], message: "download failed" }]);
    expect(result.skipped).toEqual([]);
  });

  it("stops before the next skill when batch cancellation is requested", async () => {
    const skills: Skill[] = [
      { registry: "clawhub", rawId: "first", slug: "first", name: "First" },
      { registry: "clawhub", rawId: "second", slug: "second", name: "Second" },
      { registry: "clawhub", rawId: "third", slug: "third", name: "Third" },
    ];
    let cancelled = false;
    const statuses: string[] = [];
    const result = await installSkillsSequentially(
      {
        install: async (skill) => {
          cancelled = skill.rawId === "first";
          return { ok: true };
        },
      },
      skills,
      ({ skill, status }) => statuses.push(`${skill.rawId}:${status}`),
      { shouldCancel: () => cancelled },
    );

    expect(result.succeeded.map((skill) => skill.rawId)).toEqual(["first"]);
    expect(result.skipped.map((skill) => skill.rawId)).toEqual(["second", "third"]);
    expect(statuses).toEqual([
      "first:installing",
      "first:succeeded",
      "second:skipped",
      "third:skipped",
    ]);
  });

});

describe("registry search reliability", () => {
  it("removes the trailing download count from ClawHub search result names", async () => {
    const execDebugCommand = async (_botId: string, command: string) => {
      if (command === buildClawhubSearchCommand("image")) {
        return {
          status: "SUCCESS",
          exitCode: 0,
          output: JSON.stringify({
            results: [{
              slug: "image-tools",
              displayName: "Image Tools 1,000 downloads",
              installs: 1_000,
            }],
          }),
        };
      }
      if (command === buildSkillsshSearchCommand("image")) {
        return {
          status: "SUCCESS",
          exitCode: 0,
          output: JSON.stringify({ results: [] }),
        };
      }
      throw new Error(`unexpected command: ${command}`);
    };

    const result = await createLiveDataLayer("bot-1", execDebugCommand).search("image");

    expect(result.clawhub).toEqual([
      expect.objectContaining({
        name: "Image Tools",
        installs: 1_000,
      }),
    ]);
  });

  it("does not run ClawHub searches while loading installed skills", async () => {
    const calls: string[] = [];
    const execDebugCommand = async (_botId: string, command: string) => {
      calls.push(command);
      if (command === buildClawhubListCommand()) {
        return {
          status: "SUCCESS",
          exitCode: 0,
          output: JSON.stringify({ skills: [{ slug: "react", displayName: "React" }] }),
        };
      }
      if (command === buildSkillsshListCommand()) {
        return { status: "SUCCESS", exitCode: 0, output: JSON.stringify({ skills: [] }) };
      }
      if (command === buildHermesSkillsListCommand()) {
        return { status: "SUCCESS", exitCode: 0, output: "" };
      }
      throw new Error(`unexpected command: ${command}`);
    };

    const result = await createLiveDataLayer("bot-1", execDebugCommand).listInstalled();

    expect(calls.some((command) => command.startsWith("acli clawhub search"))).toBe(false);
    expect(result.skills).toEqual(expect.arrayContaining([
      expect.objectContaining({
        rawId: "react",
      }),
    ]));
    expect(result.skills.find((skill) => skill.rawId === "react")?.sourceUrls?.clawhub).toBeUndefined();
  });

  it("reports a failed international source and applies a finite search timeout", async () => {
    const calls: Array<{ command: string; timeoutMs?: number }> = [];
    const execDebugCommand = async (
      _botId: string,
      command: string,
      options?: { timeoutMs?: number },
    ) => {
      calls.push({ command, timeoutMs: options?.timeoutMs });
      if (command.startsWith("acli clawhub search")) throw new Error("clawhub unavailable");
      return {
        status: "SUCCESS",
        exitCode: 0,
        output: JSON.stringify({ success: true, data: { skills: [] } }),
      };
    };

    const result = await createLiveDataLayer("bot-1", execDebugCommand).search("image");

    expect(result.failedSources).toEqual(["clawhub"]);
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.timeoutMs === 30_000)).toBe(true);
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
    expect(parseInstallOk(JSON.stringify({ success: true, data: { status: "already-installed" } }))).toBe(true);
    expect(parseInstallOk(JSON.stringify({ data: { status: "install_failed" } }))).toBe(false);
    expect(parseInstallOk(JSON.stringify({ data: { status: "not_installed" } }))).toBe(false);
    expect(parseUninstallOk(JSON.stringify({ success: true, data: { status: "uninstalled" } }))).toBe(true);
    expect(parseUninstallOk(JSON.stringify({ data: { status: "not_uninstalled" } }))).toBe(false);
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
