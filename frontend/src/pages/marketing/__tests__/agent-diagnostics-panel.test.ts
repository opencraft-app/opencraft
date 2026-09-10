import { describe, expect, it } from "vitest";

import {
  AGENT_DIAGNOSTIC_COMMANDS,
  buildDiagnosticLogsFileName,
  buildLogsCommand,
  buildLogsExportCommand,
  getAgentDiagnosticCommands,
  getDiagnosticRunStatus,
  normalizeDiagnosticOutput,
} from "../agent-diagnostics-panel";

describe("agent diagnostics commands", () => {
  it("runs the expected Hermes diagnostic commands", () => {
    expect(AGENT_DIAGNOSTIC_COMMANDS.map((item) => item.command)).toEqual([
      "hermes -p 'default' logs --since 1h",
    ]);
  });

  it("builds logs commands for the selected time window without unsupported limit args", () => {
    expect(buildLogsCommand("6h")).toBe("hermes -p 'default' logs --since 6h");
    expect(getAgentDiagnosticCommands("24h").map((item) => item.command)).toEqual([
      "hermes -p 'default' logs --since 24h",
    ]);
  });

  it("builds Profile-scoped logs export commands", () => {
    expect(buildLogsExportCommand("24h")).toBe("hermes -p 'default' logs --since 24h");
  });

  it("builds stable logs download filenames", () => {
    expect(buildDiagnosticLogsFileName("3h", new Date("2026-05-31T08:09:10"))).toBe(
      "hermes-logs-main-3h-20260531-080910.log",
    );
  });

  it("isolates named Profile queries and exports, including shell quoting", () => {
    expect(buildLogsCommand("1h", "sales")).toBe("hermes -p 'sales' logs --since 1h");
    expect(buildLogsExportCommand("3h", "support")).toBe("hermes -p 'support' logs --since 3h");
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
});
