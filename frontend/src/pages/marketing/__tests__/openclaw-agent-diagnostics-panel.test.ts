import { describe, expect, it } from "vitest";

import {
  AGENT_DIAGNOSTIC_COMMANDS,
  buildDiagnosticLogsFileName,
  buildLogsCommand,
  buildLogsExportCommand,
  getAgentDiagnosticCommands,
  getDiagnosticRunStatus,
  normalizeDiagnosticOutput,
} from "../openclaw-agent-diagnostics-panel";

describe("agent diagnostics commands", () => {
  it("runs the expected Hermes diagnostic commands", () => {
    expect(AGENT_DIAGNOSTIC_COMMANDS.map((item) => item.command)).toEqual([
      "hermes logs --since 1h --limit 200",
    ]);
  });

  it("builds logs commands for the selected time window", () => {
    expect(buildLogsCommand("6h")).toBe("hermes logs --since 6h --limit 200");
    expect(getAgentDiagnosticCommands("24h").map((item) => item.command)).toEqual([
      "hermes logs --since 24h --limit 200",
    ]);
  });

  it("builds unbounded logs export commands", () => {
    expect(buildLogsExportCommand("24h")).toBe("hermes logs --since 24h");
  });

  it("builds stable logs download filenames", () => {
    expect(buildDiagnosticLogsFileName("3h", new Date("2026-05-31T08:09:10"))).toBe(
      "hermes-logs-3h-20260531-080910.log",
    );
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
});
