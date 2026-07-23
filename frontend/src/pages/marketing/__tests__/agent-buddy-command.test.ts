import { describe, expect, it, vi } from "vitest";
import type { BotRepository } from "@/repositories/types";

import {
  HERMES_PERSONA_COMMAND_TIMEOUT_MS,
  buildHermesSoulClearCommand,
  buildHermesSoulReadCommand,
  buildHermesSoulWriteCommand,
  executeHermesPersonaCommand,
} from "../agent-buddy-command";

describe("Hermes persona commands", () => {
  it.each([
    ["write", buildHermesSoulWriteCommand("c291bA==", "2026-07-23_01-02-03-000")],
    ["clear", buildHermesSoulClearCommand("2026-07-23_01-02-03-000")],
    ["read", buildHermesSoulReadCommand()],
  ])("derives the %s command paths from HERMES_HOME with a default fallback", (_kind, command) => {
    expect(command).toContain('HERMES_ROOT="${HERMES_HOME:-$HOME/.hermes}"');
    expect(command).toContain('TARGET="$HERMES_ROOT/SOUL.md"');
    expect(command).not.toContain('WORKSPACE_DIR="${HOME}/.hermes"');
    expect(command).not.toContain('TARGET="${HOME}/.hermes/SOUL.md"');
  });

  it("bounds debug execution and accepts only successful status plus exit code", async () => {
    const execDebugCommand = vi.fn().mockResolvedValue({
      status: "Succeeded",
      exitCode: 0,
      output: "ok",
    });
    const bots = { execDebugCommand } as Pick<BotRepository, "execDebugCommand"> as BotRepository;

    await expect(
      executeHermesPersonaCommand(bots, "agent-a", "printf ok"),
    ).resolves.toMatchObject({ output: "ok" });
    expect(execDebugCommand).toHaveBeenCalledWith(
      "agent-a",
      "printf ok",
      { timeoutMs: HERMES_PERSONA_COMMAND_TIMEOUT_MS },
    );
    expect(HERMES_PERSONA_COMMAND_TIMEOUT_MS).toBe(120_000);
  });

  it.each([
    { status: "TIMEOUT", exitCode: 0 },
    { status: "FAILED", exitCode: 0 },
    { status: "SUCCESS", exitCode: 1 },
  ])("rejects a non-success command result: %o", async ({ status, exitCode }) => {
    const bots = {
      execDebugCommand: vi.fn().mockResolvedValue({
        status,
        exitCode,
        output: "persona command failed",
      }),
    } as Pick<BotRepository, "execDebugCommand"> as BotRepository;

    await expect(
      executeHermesPersonaCommand(bots, "agent-a", "printf ok"),
    ).rejects.toThrow("persona command failed");
  });
});
