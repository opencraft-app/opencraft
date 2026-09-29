import { cleanup, act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentOnboardingPanel } from "../agent-onboarding-panel";
import { buildBuddySetupPlan, SANDBOX_PROBE_TIMEOUT_MS } from "../agent-buddy-setup";
import { buildSetupPlanSignature, loadBuddySetupSnapshot, saveBuddySetupSnapshot } from "../agent-buddy-setup-progress";

vi.mock("@/i18n/t", () => {
  const t = (text: string) => text;
  return { useT: () => t, t };
});
const ok = { status: "ok", exitCode: 0, output: "" };
const profile = { name: "恢复中的 Bot", description: "测试" };
const avatar = { shapeId: "circle", color: "#fff" };
const plan = buildBuddySetupPlan({ profile, avatar, profileId: "profile-1", timestamp: "test" });
const snapshot = {
  botId: "bot-1", profileId: "profile-1", profile, avatar,
  templateId: "", preserveSoul: false, completedKeys: ["0:soul", "1:profile-meta"],
  planSignature: buildSetupPlanSignature(plan),
};
function unloadPrevented() {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}
beforeEach(() => window.sessionStorage.clear());
afterEach(cleanup);

describe("refresh recovery", () => {
  it("shows warmup feedback while a restored sandbox probe is pending", async () => {
    saveBuddySetupSnapshot({ ...snapshot, completedKeys: [] });
    let resolveProbe!: (value: typeof ok) => void;
    const exec = vi.fn(async (_botId: string, command: string) => command === "true"
      ? new Promise<typeof ok>((resolve) => { resolveProbe = resolve; })
      : ok);
    const onCreated = vi.fn();
    render(<AgentOnboardingPanel botId="bot-1" profileId="profile-1"
      execDebugCommand={exec} onCreated={onCreated} />);

    await waitFor(() => expect(exec).toHaveBeenCalledTimes(1));
    expect(screen.getByText("正在唤醒 Bot 实例")).toBeTruthy();
    expect(screen.getByText(/已等待/)).toBeTruthy();
    expect(onCreated).not.toHaveBeenCalled();

    await act(async () => resolveProbe(ok));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("bot-1"));
    expect(screen.queryByText(/已等待/)).toBeNull();
  });

  it("resumes after metadata without creating another Bot or rewriting completed steps", async () => {
    saveBuddySetupSnapshot(snapshot);
    const exec = vi.fn(async () => ok);
    const onCreateBot = vi.fn();
    const onCreated = vi.fn();
    const onSetupStart = vi.fn();
    render(<StrictMode><AgentOnboardingPanel botId="bot-1" profileId="profile-1"
      execDebugCommand={exec} onCreated={onCreated} onCreateBot={onCreateBot} onSetupStart={onSetupStart} /></StrictMode>);
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("bot-1"));
    expect(onCreateBot).not.toHaveBeenCalled();
    expect(onSetupStart).toHaveBeenCalledTimes(1);
    expect(exec.mock.calls).toEqual([
      // 第一条永远是探活；超时取常量，避免调参后又要来改这个断言
      ["bot-1", "true", { timeoutMs: SANDBOX_PROBE_TIMEOUT_MS }],
      ["bot-1", plan.at(-1)!.command, { timeoutMs: plan.at(-1)!.timeoutMs }],
    ]);
    expect(loadBuddySetupSnapshot("bot-1")).toBeNull();
    await waitFor(() => expect(unloadPrevented()).toBe(false));
  });

  it.each([["bot-2", "profile-1"], ["bot-1", "profile-other"], ["", ""]])(
    "does not resume another target (%s, %s)", async (botId, profileId) => {
      saveBuddySetupSnapshot(snapshot);
      const exec = vi.fn(async () => ok);
      render(<AgentOnboardingPanel botId={botId} profileId={profileId} execDebugCommand={exec} onCreated={vi.fn()} />);
      expect(screen.getByRole("button", { name: "创建" })).toBeTruthy();
      expect(exec).not.toHaveBeenCalled();
      expect(loadBuddySetupSnapshot("bot-1")).not.toBeNull();
    },
  );

  it("persists before sandbox readiness, restores even zero completed steps and removes unload guard", async () => {
    let resolveProbe!: (value: typeof ok) => void;
    const stalled = vi.fn(() => new Promise<typeof ok>((resolve) => { resolveProbe = resolve; }));
    const first = render(<AgentOnboardingPanel botId="bot-1" profileId="profile-1" execDebugCommand={stalled} onCreated={vi.fn()} />);
    expect(unloadPrevented()).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "创建" }));
    await waitFor(() => expect(stalled).toHaveBeenCalledTimes(1));
    expect(loadBuddySetupSnapshot("bot-1")?.completedKeys).toEqual([]);
    expect(unloadPrevented()).toBe(true);
    first.unmount();
    expect(unloadPrevented()).toBe(false);
    await act(async () => resolveProbe(ok));
    const onCreated = vi.fn();
    const exec = vi.fn(async () => ok);
    render(<AgentOnboardingPanel botId="bot-1" profileId="profile-1" execDebugCommand={exec} onCreated={onCreated} />);
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("bot-1"));
    expect(exec).toHaveBeenCalledTimes(4); // probe + soul + metadata + gateway
    expect(unloadPrevented()).toBe(false);
  });

  it("waits for the verified profile before recovering", async () => {
    saveBuddySetupSnapshot(snapshot);
    const exec = vi.fn(async () => ok);
    const onCreated = vi.fn();
    const view = render(<AgentOnboardingPanel botId="bot-1" profileId="" execDebugCommand={exec} onCreated={onCreated} />);
    expect(exec).not.toHaveBeenCalled();
    view.rerender(<AgentOnboardingPanel botId="bot-1" profileId="profile-1" execDebugCommand={exec} onCreated={onCreated} />);
    await waitFor(() => expect(onCreated).toHaveBeenCalledOnce());
  });

  it("stops protecting unload on a required-step failure", async () => {
    saveBuddySetupSnapshot({ ...snapshot, completedKeys: [] });
    const exec = vi.fn(async (_bot: string, command: string) => command === "true" ? ok : { ...ok, exitCode: 1, output: "write failed" });
    render(<AgentOnboardingPanel botId="bot-1" profileId="profile-1" execDebugCommand={exec} onCreated={vi.fn()} />);
    await screen.findAllByText("write failed");
    expect(unloadPrevented()).toBe(false);
    expect(loadBuddySetupSnapshot("bot-1")).not.toBeNull();
    expect(screen.getByRole("button", { name: "重试" })).toBeTruthy();
  });

  it.each(["invalid", "missing", "failed", "network"])("preserves cloned SOUL on %s reads and retries the same created Bot", async (failure) => {
    const onCreateBot = vi.fn(async () => ({ botId: "bot-new", profileId: "profile-new" }));
    const onCreated = vi.fn();
    let retry = false;
    const soul = "Inherited instructions";
    const soulOutput = `Exists: yes\nByteLength: ${soul.length}\nContentBase64: ${btoa(soul)}`;
    const exec = vi.fn(async (_bot: string, command: string) => {
      if (command.includes("ContentBase64:")) {
        if (retry) return { ...ok, output: soulOutput };
        if (failure === "network") throw new Error("network unavailable");
        return { ...ok, exitCode: failure === "failed" ? 1 : 0,
          output: failure === "missing" ? "Exists: no" : failure === "failed" ? soulOutput : "unparseable" };
      }
      return ok;
    });
    render(<StrictMode><AgentOnboardingPanel botId="" execDebugCommand={exec}
      onCreateBot={onCreateBot} onCreated={onCreated}
      cloneOptions={{ value: "source", onChange: vi.fn(), choices: [{ id: "source", label: "Source" }] }} /></StrictMode>);
    fireEvent.click(screen.getByRole("button", { name: "创建" }));
    await screen.findByRole("alert");
    expect(exec).toHaveBeenCalledTimes(2); // probe + read; no writes
    expect(onCreated).not.toHaveBeenCalled();
    expect(unloadPrevented()).toBe(false);
    retry = true;
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("bot-new"));
    expect(onCreateBot).toHaveBeenCalledTimes(1);
    expect(new Set(exec.mock.calls.map(([id]) => id))).toEqual(new Set(["bot-new"]));
    const write = exec.mock.calls.find(([, command]) => command.includes("__CTL_SOUL_EOF__"))?.[1] ?? "";
    const encoded = write.split("\n").find((line) => /^[A-Za-z0-9+/]+=*$/.test(line) && line.length > 40);
    expect(atob(encoded ?? "")).toContain(soul);
    expect(loadBuddySetupSnapshot("bot-new")).toBeNull();
  });
});
