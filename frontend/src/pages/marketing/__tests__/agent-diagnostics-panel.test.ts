import { describe, expect, it } from "vitest";

import {
  AGENT_DIAGNOSTIC_COMMANDS,
  buildDiagnosticLogsFileName,
  buildLogsCommand,
  buildLogsExportCommand,
  collectStreamedDiagnosticOutput,
  getAgentDiagnosticCommands,
  getDiagnosticRunStatus,
  normalizeDiagnosticOutput,
  type ExecDebugCommandStream,
} from "../agent-diagnostics-panel";

describe("agent diagnostics commands", () => {
  it("runs the expected Hermes diagnostic commands", () => {
    expect(AGENT_DIAGNOSTIC_COMMANDS.map((item) => item.command)).toEqual([
      "hermes -p 'default' logs --since 1h -n 50",
    ]);
  });

  it("builds bounded preview commands for the selected time window", () => {
    expect(buildLogsCommand("6h")).toBe("hermes -p 'default' logs --since 6h -n 50");
    expect(getAgentDiagnosticCommands("24h").map((item) => item.command)).toEqual([
      "hermes -p 'default' logs --since 24h -n 50",
    ]);
  });

  it("builds large Profile-scoped logs export commands", () => {
    expect(buildLogsExportCommand("24h")).toBe("hermes -p 'default' logs --since 24h -n 100000");
  });

  it("builds stable logs download filenames", () => {
    expect(buildDiagnosticLogsFileName("3h", new Date("2026-05-31T08:09:10"))).toBe(
      "hermes-logs-main-3h-20260531-080910.log",
    );
  });

  it("isolates named Profile queries and exports, including shell quoting", () => {
    expect(buildLogsCommand("1h", "sales")).toBe("hermes -p 'sales' logs --since 1h -n 50");
    expect(buildLogsExportCommand("3h", "support")).toBe("hermes -p 'support' logs --since 3h -n 100000");
    expect(buildLogsCommand("1h", "a'b")).toContain("'a'\\''b'");
    expect(buildDiagnosticLogsFileName("1h", new Date("2026-05-31T08:09:10"), "Sales/Support"))
      .toBe("hermes-logs-Sales_Support-1h-20260531-080910.log");
  });

  it("normalizes empty command output", () => {
    expect(normalizeDiagnosticOutput("  \n ", "SUCCESS")).toBe("SUCCESS");
    expect(normalizeDiagnosticOutput(undefined, "")).toBe("暂无输出");
  });

  it("maps exec command result to success or error status", () => {
    expect(getDiagnosticRunStatus({ status: "SUCCESS", exitCode: 0 })).toBe("success");
    expect(getDiagnosticRunStatus({ status: "SUCCESS", exitCode: 1 })).toBe("error");
    expect(getDiagnosticRunStatus({ status: "FAILED", exitCode: 0 })).toBe("error");
  });

  it("keeps all streamed output when the final command result is truncated", async () => {
    const firstChunk = "a".repeat(70 * 1024);
    const secondChunk = "b".repeat(70 * 1024);
    const execDebugCommandStream: ExecDebugCommandStream = async (_botId, _command, onChunk) => {
      onChunk({ stream: "stdout", chunk: firstChunk });
      onChunk({ stream: "stdout", chunk: secondChunk });
      return { status: "SUCCESS", exitCode: 0, output: "truncated-final-output" };
    };

    const result = await collectStreamedDiagnosticOutput("bot-2", "logs", execDebugCommandStream);

    expect(result.output).toBe(firstChunk + secondChunk);
    expect(result.output.length).toBeGreaterThan(128 * 1024);
  });

  it("falls back to the final command output when the stream has no chunks", async () => {
    const execDebugCommandStream: ExecDebugCommandStream = async () => ({
      status: "SUCCESS",
      exitCode: 0,
      output: "final-output",
    });

    await expect(collectStreamedDiagnosticOutput("bot-1", "logs", execDebugCommandStream)).resolves.toEqual({
      status: "SUCCESS",
      exitCode: 0,
      output: "final-output",
    });
  });
});
