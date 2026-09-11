import { describe, expect, it } from "vitest";

import {
  getHermesProfileRootCommand,
  withHermesAgent,
  withHermesAgentCompatibility,
  withHermesProfile,
} from "../hermes-agent-command";
import { scopeHermesCronCommand } from "../hermes-cron-client";
import { buildInstalledSkillsListCommand } from "../hermes-skills-client";

describe("Hermes agent command routing", () => {
  it("keeps the public main alias for ACLI commands", () => {
    expect(withHermesAgent("acli channel status")).toBe("acli channel status --agent 'main'");
  });

  it("maps the public main alias to default for native Hermes commands", () => {
    expect(withHermesProfile("config get model.default")).toBe("hermes -p 'default' config get model.default");
    expect(scopeHermesCronCommand("hermes cron list --all", "main"))
      .toContain("hermes -p 'default' cron list --all");
    expect(buildInstalledSkillsListCommand())
      .toContain("hermes_cli.main -p 'default' skills list");
  });

  it("quotes backend-provided profile identifiers", () => {
    expect(withHermesAgent("acli provider list", "team's-bot"))
      .toBe("acli provider list --agent 'team'\\''s-bot'");
    expect(withHermesProfile("config get approvals.mode", "team's-bot"))
      .toBe("hermes -p 'team'\\''s-bot' config get approvals.mode");
  });

  it("keeps an explicit capability fallback for partially rolled out commands", () => {
    expect(withHermesAgentCompatibility("acli skills batch-install 'one two'", "acli skills batch-install", "profile-2"))
      .toBe("if acli skills batch-install --help 2>&1 | grep -q -- '--agent'; then acli skills batch-install 'one two' --agent 'profile-2'; else acli skills batch-install 'one two'; fi");
  });

  it("routes cron and notification commands to the selected profile", () => {
    const cronCommand = scopeHermesCronCommand("hermes cron list --all", "profile-2");
    const channelCommand = scopeHermesCronCommand("acli channel status", "profile-2");
    expect(cronCommand).toContain("HERMES_PROFILE_ROOT=");
    expect(cronCommand).toContain("hermes -p 'profile-2' cron list --all");
    expect(channelCommand).toContain("acli channel status --agent 'profile-2'");
  });

  it("scopes direct cron tool calls through HERMES_HOME", () => {
    const command = scopeHermesCronCommand(
      "python3 -c 'from tools.cronjob_tools import cronjob'",
      "profile-2",
    );
    expect(command).toContain('export HERMES_HOME="$HERMES_PROFILE_ROOT"');
  });

  it("routes cron metadata and managed scripts to the selected profile root", () => {
    const command = scopeHermesCronCommand(
      "cat ~/.hermes/cron/jobs.json && rm -f ~/.hermes/scripts/task.py",
      "profile-2",
    );
    expect(command).toContain('cat "$HERMES_PROFILE_ROOT/cron/jobs.json"');
    expect(command).toContain('rm -f "$HERMES_PROFILE_ROOT/scripts/task.py"');
  });

  it("reads named-profile skills from the named profile directory", () => {
    const command = buildInstalledSkillsListCommand("profile-2");
    expect(command).toContain("/profiles/profile-2");
    expect(command).toContain("hermes_cli.main -p 'profile-2' skills list");
  });

  it("keeps main at the root and namespaced profiles below profiles", () => {
    expect(getHermesProfileRootCommand("main")).toBe('HERMES_PROFILE_ROOT="${HERMES_HOME:-$HOME/.hermes}"');
    expect(getHermesProfileRootCommand("profile-2")).toBe('HERMES_PROFILE_ROOT="${HERMES_HOME:-$HOME/.hermes}/profiles/"\'profile-2\'');
  });
});
