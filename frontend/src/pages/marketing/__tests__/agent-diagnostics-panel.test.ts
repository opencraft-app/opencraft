import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AGENT_DIAGNOSTIC_COMMANDS,
  AgentDiagnosticsPanel,
  buildDiagnosticLogsFileName,
  buildLogsCommand,
  buildLogsExportCommand,
  buildSessionRepairCommand,
  collectStreamedDiagnosticOutput,
  getAgentDiagnosticCommands,
  getDiagnosticRunStatus,
  normalizeDiagnosticOutput,
  type ExecDebugCommandStream,
} from "../agent-diagnostics-panel";

vi.mock("@/lib/toast", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function diagnosticsPanelProps(execDebugCommand = vi.fn().mockResolvedValue({
  status: "SUCCESS",
  exitCode: 0,
  output: "Repair completed",
})) {
  return {
    botId: "bot-1",
    profileId: "support",
    botName: "Support",
    isMainBot: false,
    execDebugCommand,
    execDebugCommandStream: vi.fn(),
    resetConfigAction: { disabled: false, loading: false, tooltip: "", onExecute: vi.fn() },
    resetAgentAction: { disabled: false, loading: false, tooltip: "", onExecute: vi.fn() },
    resetAgentConsole: [],
    resetAgentConsoleRef: { current: null },
  };
}

function renderDiagnosticsPanel(execDebugCommand = vi.fn().mockResolvedValue({
  status: "SUCCESS",
  exitCode: 0,
  output: "Repair completed",
})) {
  render(createElement(AgentDiagnosticsPanel, diagnosticsPanelProps(execDebugCommand)));
  return execDebugCommand;
}

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

  it("builds Profile-scoped session repair commands", () => {
    expect(buildSessionRepairCommand()).toBe("hermes -p 'default' sessions repair");
    expect(buildSessionRepairCommand("support")).toBe("hermes -p 'support' sessions repair");
    expect(buildSessionRepairCommand("a'b")).toContain("'a'\\''b'");
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

describe("session repair", () => {
  it("shows the requested card copy and opens common errors by hover, focus, and click", async () => {
    const user = userEvent.setup();
    renderDiagnosticsPanel();

    expect(screen.getByRole("heading", { name: "会话修复" })).toBeInTheDocument();
    expect(screen.getByText(/用于修复会话中出现的异常问题，点此查看/)).toBeInTheDocument();
    const commonErrors = screen.getByRole("button", { name: "查看常见报错" });

    await user.hover(commonErrors);
    const hoverTooltip = await screen.findByRole("tooltip");
    expect(hoverTooltip).toHaveTextContent("Sorry, I encountered an unexpected error.");
    fireEvent.mouseLeave(commonErrors);
    fireEvent.mouseEnter(hoverTooltip);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    fireEvent.mouseLeave(hoverTooltip);
    await waitFor(() => expect(screen.queryByRole("tooltip")).not.toBeInTheDocument());

    commonErrors.focus();
    expect(await screen.findByRole("tooltip")).toBeInTheDocument();
    commonErrors.blur();
    await waitFor(() => expect(screen.queryByRole("tooltip")).not.toBeInTheDocument());

    await user.click(commonErrors);
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Try again or use /reset to start a fresh session.");
  });

  it("asks for confirmation and runs repair for the current Profile", async () => {
    const user = userEvent.setup();
    const execDebugCommand = renderDiagnosticsPanel();

    await user.click(screen.getByRole("button", { name: "修复" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Hermes 将检查 state.db，并在发现异常时自动创建备份后执行修复。")).toBeInTheDocument();
    expect(execDebugCommand).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole("button", { name: "确认修复" }));

    await waitFor(() => {
      expect(execDebugCommand).toHaveBeenCalledWith("bot-1", "hermes -p 'support' sessions repair");
    });
    expect(await screen.findByRole("status")).toHaveTextContent("Repair completed");
  });

  it("disables duplicate repair while the command is running", async () => {
    let resolveRepair: ((value: { status: string; exitCode: number; output: string }) => void) | undefined;
    const execDebugCommand = vi.fn(() => new Promise<{ status: string; exitCode: number; output: string }>((resolve) => {
      resolveRepair = resolve;
    }));
    renderDiagnosticsPanel(execDebugCommand);

    fireEvent.click(screen.getByRole("button", { name: "修复" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "确认修复" }));

    const loadingButton = await screen.findByRole("button", { name: "修复中..." });
    expect(loadingButton).toBeDisabled();
    expect(loadingButton).toHaveAttribute("aria-busy", "true");
    expect(execDebugCommand).toHaveBeenCalledTimes(1);

    resolveRepair?.({ status: "SUCCESS", exitCode: 0, output: "done" });
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("done"));
  });

  it("shows command failures next to the repair action", async () => {
    const execDebugCommand = vi.fn().mockResolvedValue({ status: "FAILED", exitCode: 1, output: "database is locked" });
    renderDiagnosticsPanel(execDebugCommand);

    fireEvent.click(screen.getByRole("button", { name: "修复" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "确认修复" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("database is locked");
  });

  it("shows thrown command errors next to the repair action", async () => {
    const execDebugCommand = vi.fn().mockRejectedValue(new Error("repair unavailable"));
    renderDiagnosticsPanel(execDebugCommand);

    fireEvent.click(screen.getByRole("button", { name: "修复" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "确认修复" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("repair unavailable");
  });

  it("clears a previous repair result when switching Profiles", async () => {
    const execDebugCommand = vi.fn().mockResolvedValue({ status: "SUCCESS", exitCode: 0, output: "support repaired" });
    const view = render(createElement(AgentDiagnosticsPanel, diagnosticsPanelProps(execDebugCommand)));

    fireEvent.click(screen.getByRole("button", { name: "修复" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "确认修复" }));
    expect(await screen.findByRole("status")).toHaveTextContent("support repaired");

    view.rerender(createElement(AgentDiagnosticsPanel, {
      ...diagnosticsPanelProps(execDebugCommand),
      botId: "bot-2",
      profileId: "sales",
      botName: "Sales",
    }));

    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
  });

  it("does not write a stale repair result after switching Profiles", async () => {
    let resolveRepair: ((value: { status: string; exitCode: number; output: string }) => void) | undefined;
    const execDebugCommand = vi.fn(() => new Promise<{ status: string; exitCode: number; output: string }>((resolve) => {
      resolveRepair = resolve;
    }));
    const view = render(createElement(AgentDiagnosticsPanel, diagnosticsPanelProps(execDebugCommand)));

    fireEvent.click(screen.getByRole("button", { name: "修复" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "确认修复" }));
    expect(await screen.findByRole("status")).toHaveTextContent("正在检查并修复会话...");

    view.rerender(createElement(AgentDiagnosticsPanel, {
      ...diagnosticsPanelProps(execDebugCommand),
      botId: "bot-2",
      profileId: "sales",
      botName: "Sales",
    }));
    resolveRepair?.({ status: "SUCCESS", exitCode: 0, output: "stale support result" });

    await waitFor(() => expect(screen.queryByText("stale support result")).not.toBeInTheDocument());
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
