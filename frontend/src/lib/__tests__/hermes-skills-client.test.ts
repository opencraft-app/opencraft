import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { execCommand } from "@/lib/hermes-cron-client";
import {
  buildGithubSkillInstallCommand,
  buildHermesSkillDeleteCommand,
  buildInstalledSkillsListCommand,
  formatInstalledSkillDisplayName,
  getUniqueSkillSlugs,
  hasHermesBundledSkillsOptOut,
  listInstalledSkillSlugs,
  matchesInstalledSkillSearch,
  parseInstalledSkills,
  parseInstalledSkillSlugs,
} from "@/lib/hermes-skills-client";

vi.mock("@/lib/hermes-cron-client", () => ({
  execCommand: vi.fn(),
}));

const execFileAsync = promisify(execFile);

describe("hermes skills client", () => {
  describe("buildGithubSkillInstallCommand", () => {
    const source = {
      repo: "NousResearch/hermes-agent",
      ref: "main",
      path: "optional-skills/finance/stocks",
    };

    it("downloads only the target subdirectory from the repo tarball", () => {
      const cmd = buildGithubSkillInstallCommand(source, "finance/stocks", "main");
      expect(cmd).toContain("codeload.github.com/NousResearch/hermes-agent/tar.gz/refs/heads/main");
      // strip-components = 1 (tarball 顶层) + 3 (optional-skills/finance/stocks)
      expect(cmd).toContain("--strip-components=4");
      expect(cmd).toContain("'hermes-agent-main/optional-skills/finance/stocks'");
    });

    it("installs to the directory named by installDir, keeping category depth", () => {
      // SKILL.md 自述路径含 finance 层级，装错层级 agent 会 file-not-found
      const cmd = buildGithubSkillInstallCommand(source, "finance/stocks", "main");
      expect(cmd).toContain('"$HERMES_PROFILE_ROOT/skills/finance/stocks"');
      expect(cmd).toContain('mkdir -p "$(dirname "$HERMES_PROFILE_ROOT/skills/finance/stocks")"');
    });

    it("verifies SKILL.md before and after install", () => {
      const cmd = buildGithubSkillInstallCommand(source, "finance/stocks", "main");
      // 解压后先校验，避免把空目录当成装好了
      expect(cmd).toContain('test -f "$SKILL_TMP/extract/SKILL.md"');
      // 收尾自检落盘契约
      expect(cmd).toContain('test -f "$HERMES_PROFILE_ROOT/skills/finance/stocks"/SKILL.md');
    });

    it("always cleans up the temp directory", () => {
      const cmd = buildGithubSkillInstallCommand(source, "finance/stocks", "main");
      expect(cmd).toContain(`trap 'rm -rf "$SKILL_TMP"' EXIT`);
    });

    it("rejects injection and traversal in every input", () => {
      expect(() => buildGithubSkillInstallCommand({ ...source, repo: "a/b; rm -rf /" }, "x"))
        .toThrow(/Invalid GitHub repo/);
      expect(() => buildGithubSkillInstallCommand({ ...source, ref: "main;whoami" }, "x"))
        .toThrow(/Invalid GitHub ref/);
      expect(() => buildGithubSkillInstallCommand({ ...source, path: "../../etc" }, "x"))
        .toThrow(/Invalid GitHub path/);
      expect(() => buildGithubSkillInstallCommand(source, "../escape"))
        .toThrow(/Invalid skill directory name/);
      expect(() => buildGithubSkillInstallCommand(source, "a/$(id)"))
        .toThrow(/Invalid skill directory name/);
    });
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("builds the Hermes installed-skills command", () => {
    const command = buildInstalledSkillsListCommand();
    expect(command).toContain("hermes_cli.main -p 'default' skills list");
    expect(command).toContain("__HERMES_BUNDLED_MANIFEST__");
    expect(command).toContain("__HERMES_SKILLS_ROOT__");
    expect(command).toContain("__HERMES_NO_BUNDLED_SKILLS__");
    expect(command).toContain('test -f "$HERMES_PROFILE_ROOT/.no-bundled-skills"');
    expect(command).toContain('find "$HERMES_PROFILE_ROOT/skills" -mindepth 2 -type f -name SKILL.md -print');
  });

  it("detects the bundled-skills opt-out marker", () => {
    expect(hasHermesBundledSkillsOptOut("skills output\n__HERMES_NO_BUNDLED_SKILLS__\n")).toBe(true);
    expect(hasHermesBundledSkillsOptOut("skills output")).toBe(false);
  });

  it("builds a constrained delete command for nested Hermes-native skill directories", () => {
    const command = buildHermesSkillDeleteCommand("finance-news");
    expect(command).toContain('find "$HERMES_PROFILE_ROOT/skills"');
    expect(command).toContain('echo "Hermes skill not found: finance-news" >&2; exit 1');
    expect(command).toContain('rm -rf -- {} +');
    expect(() => buildHermesSkillDeleteCommand("../finance-news")).toThrow("Invalid Hermes skill slug");
    expect(() => buildHermesSkillDeleteCommand("finance/news")).toThrow("Invalid Hermes skill slug");
    expect(() => buildHermesSkillDeleteCommand("finance; whoami")).toThrow("Invalid Hermes skill slug");
  });

  it("deletes a nested Hermes-native skill directory and fails when it is already absent", async () => {
    const taskTempDir = await mkdtemp(join(tmpdir(), "hermes-skill-delete-"));
    const skillDir = join(taskTempDir, ".hermes", "skills", "software-development", "finance-news");
    const command = buildHermesSkillDeleteCommand("finance-news");
    const env = { ...process.env, HOME: taskTempDir };
    try {
      await mkdir(skillDir, { recursive: true });
      await writeFile(join(skillDir, "SKILL.md"), "# Finance News\n", "utf8");

      await expect(execFileAsync("/bin/sh", ["-c", command], { env })).resolves.toBeDefined();
      await expect(access(skillDir)).rejects.toBeDefined();
      await expect(execFileAsync("/bin/sh", ["-c", command], { env })).rejects.toMatchObject({ code: 1 });
    } finally {
      await rm(taskTempDir, { recursive: true, force: true });
    }
  });

  it("fails the Hermes delete command when rm reports an error even if the target disappeared", async () => {
    const taskTempDir = await mkdtemp(join(tmpdir(), "hermes-skill-delete-rm-error-"));
    const skillDir = join(taskTempDir, ".hermes", "skills", "utility", "failing-delete");
    const fakeBinDir = join(taskTempDir, "bin");
    const fakeRmPath = join(fakeBinDir, "rm");
    const command = buildHermesSkillDeleteCommand("failing-delete");
    const env = {
      ...process.env,
      HOME: taskTempDir,
      PATH: `${fakeBinDir}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    };
    try {
      await mkdir(skillDir, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });
      await writeFile(join(skillDir, "SKILL.md"), "# Failing Delete\n", "utf8");
      await writeFile(fakeRmPath, "#!/bin/sh\n/bin/rm \"$@\"\nexit 1\n", "utf8");
      await chmod(fakeRmPath, 0o755);

      await expect(execFileAsync("/bin/sh", ["-c", command], { env })).rejects.toMatchObject({ code: 1 });
      await expect(access(skillDir)).rejects.toBeDefined();
    } finally {
      await rm(taskTempDir, { recursive: true, force: true });
    }
  });

  it("deduplicates normalized slugs while preserving their first-seen order", () => {
    expect(getUniqueSkillSlugs([" finance-news ", "market", "finance-news", "", "market"])).toEqual([
      "finance-news",
      "market",
    ]);
  });

  it("parses installed slugs from Hermes JSON payloads", () => {
    expect(parseInstalledSkillSlugs(JSON.stringify({
      success: true,
      data: { skills: [{ name: "market-data" }, { slug: "backtest-engine" }] },
    }))).toEqual(["market-data", "backtest-engine"]);

    expect(parseInstalledSkillSlugs(JSON.stringify([
      { name: "market-data" },
      "backtest-engine",
    ]))).toEqual(["market-data", "backtest-engine"]);
  });

  it("parses installed slugs from Hermes table output", () => {
    expect(parseInstalledSkillSlugs(
      "│ Name │ Category │ Source │ Trust │ Status │\n│ cody │ dev │ local │ yes │ installed │",
    )).toEqual(["cody"]);
  });

  it("preserves local and builtin sources from Hermes output", () => {
    expect(parseInstalledSkills(
      "│ Name │ Category │ Source │ Trust │ Status │\n"
      + "│ local-skill │ dev │ local │ yes │ installed │\n"
      + "│ bundled-skill │ dev │ builtin │ builtin │ enabled │",
    )).toEqual([
      { slug: "local-skill", category: "dev", source: "local", status: "installed" },
      { slug: "bundled-skill", category: "dev", source: "builtin", status: "enabled" },
    ]);

    expect(parseInstalledSkills(JSON.stringify({
      success: true,
      data: { skills: [{ name: "local-skill", category: "dev", source: "local" }] },
    }))).toEqual([{ slug: "local-skill", category: "dev", source: "local" }]);
  });

  it("parses Hermes Rich tables whose header and data rows use different vertical borders", () => {
    expect(parseInstalledSkills(
      "┃ Name                 ┃ Category             ┃ Source  ┃ Trust   ┃ Status  ┃\n"
      + "│ architecture-diagram │ creative             │ builtin │ builtin │ enabled │\n"
      + "│ maps                 │ productivity         │ builtin │ builtin │ enabled │\n"
      + "│ plan                 │ software-development │ builtin │ builtin │ enabled │",
    )).toEqual([
      { slug: "architecture-diagram", category: "creative", source: "builtin", status: "enabled" },
      { slug: "maps", category: "productivity", source: "builtin", status: "enabled" },
      { slug: "plan", category: "software-development", source: "builtin", status: "enabled" },
    ]);
  });

  it("uses the Hermes manifest as the authoritative bundled source", () => {
    expect(parseInstalledSkills(
      "│ Name │ Category │ Status │\n"
      + "│ architecture-diagram │ creative │ enabled │\n"
      + "│ local-skill │ dev │ enabled │\n"
      + "\n__HERMES_BUNDLED_MANIFEST__\n"
      + "architecture-diagram:abc123\n"
      + "local-skill:def456\n",
    )).toEqual([
      { slug: "architecture-diagram", category: "creative", source: "builtin", status: "enabled" },
      { slug: "local-skill", category: "dev", source: "builtin", status: "enabled" },
    ]);

    expect(parseInstalledSkills(
      "│ Name │ Category │ Source │ Status │\n"
      + "│ local-skill │ dev │ local │ enabled │\n"
      + "\n__HERMES_BUNDLED_MANIFEST__\n"
      + "local-skill:def456\n",
    )).toEqual([{ slug: "local-skill", category: "dev", source: "builtin", status: "enabled" }]);
  });

  it("maps non-bundled skills under the Hermes skills root to other", () => {
    expect(parseInstalledSkills(
      "│ Name │ Category │ Source │ Status │\n"
      + "│ chat-installed │ utility │ local │ enabled │\n"
      + "│ external-local │ utility │ local │ enabled │\n"
      + "\n__HERMES_BUNDLED_MANIFEST__\n"
      + "\n__HERMES_SKILLS_ROOT__\n"
      + "/home/agentuser/.hermes/skills/utility/chat-installed/SKILL.md\n",
    )).toEqual([
      { slug: "chat-installed", category: "utility", source: "other", status: "enabled" },
      { slug: "external-local", category: "utility", source: "local", status: "enabled" },
    ]);
  });

  it("falls back to one slug per line", () => {
    expect(parseInstalledSkillSlugs(" alpha \nalpha\nbeta\n")).toEqual(["alpha", "beta"]);
  });

  it("formats a readable name without changing the persisted slug", () => {
    expect(formatInstalledSkillDisplayName("finance-news_digest")).toBe("Finance News Digest");
  });

  it("matches search against either display name or slug case-insensitively", () => {
    expect(matchesInstalledSkillSearch("finance-news", "Finance News", "NEWS")).toBe(true);
    expect(matchesInstalledSkillSearch("finance-news", "Finance News", "finance-")).toBe(true);
    expect(matchesInstalledSkillSearch("finance-news", "Finance News", "legal")).toBe(false);
  });

  it("loads and parses installed slugs for the requested Agent", async () => {
    vi.mocked(execCommand).mockResolvedValue({
      status: "SUCCESS",
      exit_code: 0,
      output: JSON.stringify({ success: true, data: { skills: [{ name: "market-data" }] } }),
    });

    await expect(listInstalledSkillSlugs("bot-1")).resolves.toEqual(["market-data"]);
    expect(execCommand).toHaveBeenCalledWith("bot-1", buildInstalledSkillsListCommand());
  });
});
