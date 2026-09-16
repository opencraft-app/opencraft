import { createRef } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AgentDiagnosticsPanel } from "../agent-diagnostics-panel";
vi.mock("@/i18n/t", () => ({ useT: () => (text: string) => text }));
vi.mock("@/lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
beforeAll(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  Object.defineProperties(HTMLElement.prototype, {
    hasPointerCapture: { configurable: true, value: () => false },
    releasePointerCapture: { configurable: true, value() {} },
    setPointerCapture: { configurable: true, value() {} },
    scrollIntoView: { configurable: true, value() {} },
  });
});
afterEach(cleanup);
afterAll(() => vi.unstubAllGlobals());
describe("Diagnostics log controls", () => {
  function setup() {
    const execute = vi.fn().mockResolvedValue({ status: "SUCCESS", exitCode: 0, output: "Log output" });
    const action = { disabled: true, loading: false, tooltip: "主 Bot 中操作", onExecute: vi.fn() };
    render(<AgentDiagnosticsPanel botId="bot-sales" profileId="sales" botName="Sales" isMainBot={false}
      execDebugCommand={execute} execDebugCommandStream={vi.fn()} resetConfigAction={action} resetAgentAction={action}
      resetAgentConsole={[]} resetAgentConsoleRef={createRef()} />);
    return execute;
  }
  it("closes the time menu with Escape and restores focus without querying", async () => {
    const execute = setup();
    const user = userEvent.setup();
    const trigger = screen.getByLabelText("选择日志时间段");
    await user.click(trigger);
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("listbox")).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
    expect(execute).not.toHaveBeenCalled();
  });
  it("only queries after an explicit action, keeping the selected Profile and preview bound", async () => {
    const execute = setup();
    const user = userEvent.setup();
    await user.click(screen.getByLabelText("选择日志时间段"));
    await user.click(screen.getByRole("option", { name: "6 小时" }));
    expect(execute).not.toHaveBeenCalled();
    await user.click(screen.getAllByRole("button", { name: "查询" })[0]!);
    await waitFor(() => expect(execute).toHaveBeenCalledWith("bot-sales", "hermes -p 'sales' logs --since 6h -n 50"));
    expect(await screen.findByText("Log output")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "重置 Hermes（保留数据）" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "重置模型配置" })).toBeInTheDocument();
  });
});
