import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LocaleOverrideProvider } from "@/i18n/t";

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

const toastMocks = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@/lib/toast", () => ({ toast: toastMocks }));

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
    maintenanceBusy: false,
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

function getSessionRepairButton() {
  const card = screen.getByRole("heading", { name: "会话修复" }).closest("article");
  if (!card) throw new Error("session repair card not found");
  return within(card).getByRole("button", { name: "执行" });
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
    expect(screen.getByText("用于修复会话中出现的异常问题。")).toBeInTheDocument();
    const commonErrors = screen.getByRole("button", { name: "查看常见报错" });

    await user.hover(commonErrors);
    const hoverTooltip = await screen.findByRole("tooltip");
    expect(hoverTooltip).toHaveTextContent("抱歉，我遇到了意外错误。");
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
    expect(await screen.findByRole("tooltip")).toHaveTextContent("请重试或使用 /reset 开始新会话。");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("tooltip")).not.toBeInTheDocument());

    await user.unhover(commonErrors);
    await user.hover(commonErrors);
    expect(await screen.findByRole("tooltip")).toBeInTheDocument();
    await user.unhover(commonErrors);
    await user.click(document.body);
    await waitFor(() => expect(screen.queryByRole("tooltip")).not.toBeInTheDocument());
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("localizes the repair description and common errors", async () => {
    const user = userEvent.setup();
    render(createElement(
      LocaleOverrideProvider,
      {
        locale: "en-US",
        children: createElement(AgentDiagnosticsPanel, diagnosticsPanelProps()),
      },
    ));

    expect(screen.getByText("Repairs unexpected session issues.")).toBeInTheDocument();
    const commonErrors = screen.getByRole("button", { name: "View common errors" });
    await user.click(commonErrors);

    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip).toHaveTextContent("Sorry, I encountered an unexpected error.");
    expect(tooltip).toHaveTextContent("Try again or use /reset to start a fresh session.");
  });

  it("keeps the common errors open after clicking during hover until outside click", async () => {
    const user = userEvent.setup();
    renderDiagnosticsPanel();
    const commonErrors = screen.getByRole("button", { name: "查看常见报错" });

    await user.hover(commonErrors);
    expect(await screen.findByRole("tooltip")).toBeInTheDocument();
    await user.click(commonErrors);
    await user.unhover(commonErrors);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(screen.getByRole("tooltip")).toBeInTheDocument();

    await user.click(document.body);
    await waitFor(() => expect(screen.queryByRole("tooltip")).not.toBeInTheDocument());
  });

  it("asks for confirmation and runs repair for the current Profile", async () => {
    const user = userEvent.setup();
    const execDebugCommand = renderDiagnosticsPanel();

    await user.click(getSessionRepairButton());
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Hermes 将检查 state.db，并在发现异常时自动创建备份后执行修复。")).toBeInTheDocument();
    expect(execDebugCommand).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole("button", { name: "确认修复" }));

    await waitFor(() => {
      expect(execDebugCommand).toHaveBeenCalledWith("bot-1", "hermes -p 'support' sessions repair");
    });
    await waitFor(() => expect(toastMocks.success).toHaveBeenCalledWith("会话修复成功"));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByText("Repair completed")).not.toBeInTheDocument();
  });

  it("disables repair for a named Bot without a Profile", () => {
    const execDebugCommand = vi.fn();
    render(createElement(AgentDiagnosticsPanel, {
      ...diagnosticsPanelProps(execDebugCommand),
      profileId: undefined,
    }));

    expect(getSessionRepairButton()).toBeDisabled();
    fireEvent.click(getSessionRepairButton());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(execDebugCommand).not.toHaveBeenCalled();
  });

  it("disables log reads and exports for a named Bot without a Profile", () => {
    const execDebugCommand = vi.fn();
    const execDebugCommandStream = vi.fn();
    render(createElement(AgentDiagnosticsPanel, {
      ...diagnosticsPanelProps(execDebugCommand),
      profileId: undefined,
      execDebugCommandStream,
    }));

    const logsCard = screen.getByRole("heading", { name: "最近日志" }).closest("article");
    if (!logsCard) throw new Error("logs card not found");
    expect(within(logsCard).queryByText("hermes -p 'default' logs --since 1h -n 50")).not.toBeInTheDocument();
    const queryButtons = within(logsCard).getAllByRole("button", { name: "查询" });
    expect(within(logsCard).getByRole("button", { name: "导出" })).toBeDisabled();
    expect(within(logsCard).getByRole("button", { name: "选择日志时间段" })).toBeDisabled();
    queryButtons.forEach((button) => expect(button).toBeDisabled());

    queryButtons.forEach((button) => fireEvent.click(button));
    fireEvent.click(within(logsCard).getByRole("button", { name: "导出" }));
    expect(execDebugCommand).not.toHaveBeenCalled();
    expect(execDebugCommandStream).not.toHaveBeenCalled();
  });

  it("disables session repair while another maintenance action is running", () => {
    const execDebugCommand = vi.fn();
    render(createElement(AgentDiagnosticsPanel, {
      ...diagnosticsPanelProps(execDebugCommand),
      maintenanceBusy: true,
    }));

    expect(getSessionRepairButton()).toBeDisabled();
    fireEvent.click(getSessionRepairButton());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(execDebugCommand).not.toHaveBeenCalled();
  });

  it("uses the default Profile when the main Bot has no Profile", async () => {
    const execDebugCommand = vi.fn().mockResolvedValue({ status: "SUCCESS", exitCode: 0, output: "done" });
    render(createElement(AgentDiagnosticsPanel, {
      ...diagnosticsPanelProps(execDebugCommand),
      profileId: undefined,
      isMainBot: true,
    }));

    fireEvent.click(getSessionRepairButton());
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "确认修复" }));

    await waitFor(() => {
      expect(execDebugCommand).toHaveBeenCalledWith("bot-1", "hermes -p 'default' sessions repair");
    });
  });

  it("disables duplicate repair while the command is running", async () => {
    let resolveRepair: ((value: { status: string; exitCode: number; output: string }) => void) | undefined;
    const execDebugCommand = vi.fn(() => new Promise<{ status: string; exitCode: number; output: string }>((resolve) => {
      resolveRepair = resolve;
    }));
    renderDiagnosticsPanel(execDebugCommand);

    fireEvent.click(getSessionRepairButton());
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "确认修复" }));

    const loadingButton = await screen.findByRole("button", { name: "修复中..." });
    expect(loadingButton).toBeDisabled();
    expect(loadingButton).toHaveAttribute("aria-busy", "true");
    expect(execDebugCommand).toHaveBeenCalledTimes(1);

    resolveRepair?.({ status: "SUCCESS", exitCode: 0, output: "done" });
    await waitFor(() => expect(getSessionRepairButton()).toBeEnabled());
    expect(toastMocks.success).toHaveBeenCalledWith("会话修复成功");
    expect(screen.queryByText("done")).not.toBeInTheDocument();
  });

  it("shows command failures with the shared top toast", async () => {
    const execDebugCommand = vi.fn().mockResolvedValue({ status: "FAILED", exitCode: 1, output: "database is locked" });
    renderDiagnosticsPanel(execDebugCommand);

    fireEvent.click(getSessionRepairButton());
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "确认修复" }));

    await waitFor(() => expect(toastMocks.error).toHaveBeenCalledWith("会话修复失败"));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText("database is locked")).not.toBeInTheDocument();
  });

  it("shows thrown command errors with the shared top toast", async () => {
    const execDebugCommand = vi.fn().mockRejectedValue(new Error("repair unavailable"));
    renderDiagnosticsPanel(execDebugCommand);

    fireEvent.click(getSessionRepairButton());
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "确认修复" }));

    await waitFor(() => expect(toastMocks.error).toHaveBeenCalledWith("会话修复失败"));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText("repair unavailable")).not.toBeInTheDocument();
  });

  it("keeps the repair card free of command output when switching Profiles", async () => {
    const execDebugCommand = vi.fn().mockResolvedValue({ status: "SUCCESS", exitCode: 0, output: "support repaired" });
    const view = render(createElement(AgentDiagnosticsPanel, diagnosticsPanelProps(execDebugCommand)));

    fireEvent.click(getSessionRepairButton());
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "确认修复" }));
    await waitFor(() => expect(toastMocks.success).toHaveBeenCalledWith("会话修复成功"));
    expect(screen.queryByText("support repaired")).not.toBeInTheDocument();

    view.rerender(createElement(AgentDiagnosticsPanel, {
      ...diagnosticsPanelProps(execDebugCommand),
      botId: "bot-2",
      profileId: "sales",
      botName: "Sales",
    }));

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("does not write a stale repair result after switching Profiles", async () => {
    let resolveRepair: ((value: { status: string; exitCode: number; output: string }) => void) | undefined;
    const execDebugCommand = vi.fn(() => new Promise<{ status: string; exitCode: number; output: string }>((resolve) => {
      resolveRepair = resolve;
    }));
    const view = render(createElement(AgentDiagnosticsPanel, diagnosticsPanelProps(execDebugCommand)));

    fireEvent.click(getSessionRepairButton());
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "确认修复" }));
    expect(await screen.findByRole("button", { name: "修复中..." })).toBeDisabled();

    view.rerender(createElement(AgentDiagnosticsPanel, {
      ...diagnosticsPanelProps(execDebugCommand),
      botId: "bot-2",
      profileId: "sales",
      botName: "Sales",
    }));
    resolveRepair?.({ status: "SUCCESS", exitCode: 0, output: "stale support result" });

    await waitFor(() => expect(screen.queryByText("stale support result")).not.toBeInTheDocument());
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(toastMocks.success).not.toHaveBeenCalled();
  });

  it("ignores an older repair after switching A to B to A", async () => {
    const resolvers: Array<(value: { status: string; exitCode: number; output: string }) => void> = [];
    const execDebugCommand = vi.fn(() => new Promise<{ status: string; exitCode: number; output: string }>((resolve) => {
      resolvers.push(resolve);
    }));
    const view = render(createElement(AgentDiagnosticsPanel, diagnosticsPanelProps(execDebugCommand)));

    fireEvent.click(getSessionRepairButton());
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "确认修复" }));
    expect(await screen.findByRole("button", { name: "修复中..." })).toBeDisabled();

    view.rerender(createElement(AgentDiagnosticsPanel, {
      ...diagnosticsPanelProps(execDebugCommand),
      botId: "bot-2",
      profileId: "sales",
      botName: "Sales",
    }));
    view.rerender(createElement(AgentDiagnosticsPanel, diagnosticsPanelProps(execDebugCommand)));

    fireEvent.click(getSessionRepairButton());
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "确认修复" }));
    expect(execDebugCommand).toHaveBeenCalledTimes(2);

    await act(async () => {
      resolvers[0]?.({ status: "SUCCESS", exitCode: 0, output: "first A result" });
      await Promise.resolve();
    });
    expect(screen.getByRole("button", { name: "修复中..." })).toBeDisabled();
    expect(toastMocks.success).not.toHaveBeenCalled();

    await act(async () => {
      resolvers[1]?.({ status: "SUCCESS", exitCode: 0, output: "second A result" });
      await Promise.resolve();
    });
    await waitFor(() => expect(getSessionRepairButton()).toBeEnabled());
    expect(toastMocks.success).toHaveBeenCalledTimes(1);
    expect(toastMocks.success).toHaveBeenCalledWith("会话修复成功");
  });
});
