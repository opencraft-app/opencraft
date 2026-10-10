import type { ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentOverviewPanel } from "../agent-overview-panel";
import type { SetupExec } from "../agent-buddy-setup-runner";
import { buildHermesSoulContentReadCommand } from "../agent-buddy-command";

vi.mock("@/i18n/t", () => ({ t: (value: string) => value, useT: () => (value: string) => value, useCurrentLocale: () => "zh-CN" }));
vi.mock("@/lib/app-navigation", () => ({ AppLink: ({ children }: { children: ReactNode }) => <span>{children}</span> }));
afterEach(cleanup);
const ok = { status: "success", exitCode: 0, output: "Exists: no" };
const base = {
  botId: "worker-bot", profile: { name: "Worker", description: "", shapeId: "circle" as const, color: "#fff" },
  heroStats: { servedDays: null, expiresAt: null, credits: null, automations: null, sites: null },
};

describe("overview profile editing", () => {
  it.each([
    ["network failure", new Error("timeout")],
    ["failed command", { status: "FAILED", exitCode: 0, output: "Exists: no" }],
    ["nonzero exit", { status: "success", exitCode: 1, output: "Exists: no" }],
    ["empty response", { ...ok, output: "" }],
    ["invalid content", { ...ok, output: "Exists: yes\nByteLength: 5\nContentBase64: !bad" }],
    ["empty file", { ...ok, output: "Exists: yes\nByteLength: 0\nContentBase64: " }],
    ["oversized file", { ...ok, output: "Exists: yes\nTooLarge: yes\nByteLength: 99999" }],
  ] as const)("does not write after %s and preserves the draft for retry", async (_, readResult) => {
    const exec = vi.fn<SetupExec>().mockResolvedValue(ok);
    if (readResult instanceof Error) exec.mockRejectedValueOnce(readResult);
    else exec.mockResolvedValueOnce(readResult);
    const changed = vi.fn();
    render(<AgentOverviewPanel {...base} profileId="worker" execDebugCommand={exec} onProfileChanged={changed} />);
    fireEvent.click(screen.getByRole("button", { name: "修改资料" }));
    fireEvent.change(screen.getByLabelText("名字"), { target: { value: "Draft name" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(exec).toHaveBeenCalledOnce();
    expect(changed).not.toHaveBeenCalled();
    expect(screen.getByLabelText("名字")).toHaveValue("Draft name");
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(changed).toHaveBeenCalledOnce());
    expect(exec.mock.calls[1]?.[1]).toBe(buildHermesSoulContentReadCommand("worker"));
  });

  it("preserves an existing Soul body after a successful read", async () => {
    const soul = "# Soul\nName: Worker\nSummary: Old\n\n## Identity\nKeep this custom body exactly.\n";
    const exec = vi.fn<SetupExec>().mockResolvedValue(ok).mockResolvedValueOnce({
      ...ok, output: `Exists: yes\nByteLength: ${Buffer.byteLength(soul)}\nContentBase64: ${Buffer.from(soul).toString("base64")}`,
    });
    const changed = vi.fn();
    render(<AgentOverviewPanel {...base} profileId="worker" execDebugCommand={exec} onProfileChanged={changed} />);
    fireEvent.click(screen.getByRole("button", { name: "修改资料" }));
    fireEvent.change(screen.getByLabelText("名字"), { target: { value: "Renamed" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(changed).toHaveBeenCalledOnce());
    expect(exec.mock.calls.some(([, command]) => command.includes(Buffer.from(soul.replace("Name: Worker", "Name: Renamed")).toString("base64")))).toBe(true);
  });

  it.each([undefined, "", "  "])("disables editing until profile is known (%s)", (profileId) => {
    const exec = vi.fn<SetupExec>();
    const { rerender } = render(<AgentOverviewPanel {...base} profileId={profileId} execDebugCommand={exec} onProfileChanged={vi.fn()} />);
    const edit = screen.getByRole("button", { name: "修改资料" });
    expect(edit).toBeDisabled();
    fireEvent.click(edit);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(exec).not.toHaveBeenCalled();
    rerender(<AgentOverviewPanel {...base} profileId="worker" execDebugCommand={exec} onProfileChanged={vi.fn()} />);
    expect(screen.getByRole("button", { name: "修改资料" })).toBeEnabled();
  });

  it.each(["worker", "main"])("reads and writes only the explicit %s profile", async (profileId) => {
    const exec = vi.fn<SetupExec>().mockResolvedValue(ok);
    const changed = vi.fn();
    render(<AgentOverviewPanel {...base} profileId={profileId} execDebugCommand={exec} onProfileChanged={changed} />);
    fireEvent.click(screen.getByRole("button", { name: "修改资料" }));
    fireEvent.change(screen.getByLabelText("名字"), { target: { value: "Renamed" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(changed).toHaveBeenCalledOnce());
    expect(exec.mock.calls[0]?.[1]).toBe(buildHermesSoulContentReadCommand(profileId));
    expect(exec.mock.calls.length).toBeGreaterThan(1);
    for (const [botId, command] of exec.mock.calls) {
      expect(botId).toBe(base.botId);
      if (profileId === "worker") expect(command).toMatch(/(?:profiles\/"?|--agent )'worker'/);
      else expect(command).not.toContain("profiles/");
    }
  });

  it("closes the previous edit draft when the profile disappears", () => {
    const exec = vi.fn<SetupExec>();
    const { rerender } = render(<AgentOverviewPanel {...base} profileId="worker" execDebugCommand={exec} onProfileChanged={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "修改资料" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    rerender(<AgentOverviewPanel {...base} profileId="" execDebugCommand={exec} onProfileChanged={vi.fn()} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(exec).not.toHaveBeenCalled();
  });

  it("does not start writes if the target changes while reading SOUL", async () => {
    let finish!: (value: typeof ok) => void;
    const exec = vi.fn<SetupExec>().mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const changed = vi.fn();
    const { rerender } = render(<AgentOverviewPanel {...base} profileId="worker" execDebugCommand={exec} onProfileChanged={changed} />);
    fireEvent.click(screen.getByRole("button", { name: "修改资料" }));
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(exec).toHaveBeenCalledOnce();
    rerender(<AgentOverviewPanel {...base} profileId="other" execDebugCommand={exec} onProfileChanged={changed} />);
    await act(async () => { finish(ok); });
    expect(exec).toHaveBeenCalledOnce();
    expect(changed).not.toHaveBeenCalled();
  });
});
