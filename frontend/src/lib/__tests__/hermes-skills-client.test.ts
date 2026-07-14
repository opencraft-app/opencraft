import { beforeEach, describe, expect, it, vi } from "vitest";

import { execCommand } from "@/lib/hermes-cron-client";
import {
  buildInstalledSkillsListCommand,
  formatInstalledSkillDisplayName,
  getUniqueSkillSlugs,
  listInstalledSkillSlugs,
  matchesInstalledSkillSearch,
  parseInstalledSkillSlugs,
} from "@/lib/hermes-skills-client";

vi.mock("@/lib/hermes-cron-client", () => ({
  execCommand: vi.fn(),
}));

describe("hermes skills client", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("builds the Hermes installed-skills command", () => {
    expect(buildInstalledSkillsListCommand()).toBe(
      'cd "$HOME/.hermes/hermes-agent" && COLUMNS=10000 ./venv/bin/python -m hermes_cli.main skills list',
    );
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
