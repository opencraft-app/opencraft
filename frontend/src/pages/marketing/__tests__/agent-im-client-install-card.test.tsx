import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentImClientInstallCard } from "@/pages/marketing/agent-im-client-install-card";

const availability = vi.hoisted(() => ({ published: true }));
vi.mock("@/i18n/t", () => ({ useT: () => (value: string) => value }));
vi.mock("@/lib/vela-im-client-install", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/vela-im-client-install")>();
  return { ...original, VELA_IM_CLIENT_RELEASE: { ...original.VELA_IM_CLIENT_RELEASE, get published() { return availability.published; } } };
});
afterEach(() => { cleanup(); vi.useRealTimers(); availability.published = true; });

describe("Bot IM client first install", () => {
  it("does not dispatch installation until the COS release is published", () => {
    availability.published = false;
    const execDebugCommand = vi.fn();
    render(<AgentImClientInstallCard botId="bot" bots={{ execDebugCommand }} />);
    expect(screen.getByText("安装客户端")).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("安装包尚未发布。");
    expect(execDebugCommand).not.toHaveBeenCalled();
  });
  it("uses the selected Bot and waits for installed status", async () => {
    vi.useFakeTimers();
    const execDebugCommand = vi.fn().mockResolvedValueOnce({ exitCode: 0, output: "VELA_IM_INSTALL_STARTED" }).mockResolvedValueOnce({ exitCode: 0, output: "installed" });
    render(<AgentImClientInstallCard botId="selected-bot" bots={{ execDebugCommand }} />);
    expect(execDebugCommand).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(screen.getByText("安装客户端")); });
    expect(screen.getByText("正在安装…")).toBeDisabled();
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(screen.getByText("已安装")).toBeDisabled();
    expect(execDebugCommand.mock.calls.every(([id]) => id === "selected-bot")).toBe(true);
  });
  it("does not apply a previous Bot's completion after switching", async () => {
    vi.useFakeTimers();
    const execDebugCommand = vi.fn().mockResolvedValue({ exitCode: 0, output: "VELA_IM_INSTALL_STARTED" });
    const view = render(<AgentImClientInstallCard botId="old-bot" bots={{ execDebugCommand }} />);
    await act(async () => { fireEvent.click(screen.getByText("安装客户端")); });
    view.rerender(<AgentImClientInstallCard botId="new-bot" bots={{ execDebugCommand }} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(screen.getByText("安装客户端")).toBeEnabled();
    expect(execDebugCommand).toHaveBeenCalledTimes(1);
  });
  it("reports launch failures and permits retry", async () => {
    const execDebugCommand = vi.fn().mockResolvedValue({ exitCode: 1, output: "failed" });
    render(<AgentImClientInstallCard botId="bot" bots={{ execDebugCommand }} />);
    fireEvent.click(screen.getByText("安装客户端"));
    expect(await screen.findByRole("alert")).toHaveTextContent("安装失败，请重试。");
    expect(screen.getByText("安装客户端")).toBeEnabled();
  });
});
