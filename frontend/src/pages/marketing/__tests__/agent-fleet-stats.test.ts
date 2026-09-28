import { describe, expect, it, vi } from "vitest";
import { getBotAutomationTarget, loadBotAutomationCounts, sumBotAutomationCounts } from "@/pages/marketing/agent-fleet-stats";
vi.mock("@/lib/hermes-cron-client", () => ({ listCronJobs: vi.fn() }));
vi.mock("@/pages/marketing/agent-automations-panel", () => ({ isCronJobExpired: () => false }));
const scopes = Array.from({ length: 8 }, (_, index) => ({ id: String(index), profileId: `profile-${index}`, status: "running" as const }));
describe("fleet statistics isolation", () => {
  it("queries the physical instance with the chosen Bot profile", () => {
    expect(getBotAutomationTarget({ id: "child-bot", instanceId: "vm-1", profileId: "child", status: "running" })).toEqual({ instanceId: "vm-1", profileId: "child" });
  });
  it("never publishes a partial total as a complete count", () => {
    expect(sumBotAutomationCounts(scopes.slice(0, 2), { "0": 4 })).toBeNull();
    expect(sumBotAutomationCounts(scopes.slice(0, 2), { "0": 4, "1": null })).toBeNull();
    expect(sumBotAutomationCounts(scopes.slice(0, 2), { "0": 4, "1": 0 })).toBe(4);
    expect(sumBotAutomationCounts([], {})).toBe(0);
  });
  it("bounds concurrency and retains each result under its own Bot ID", async () => {
    let running = 0, max = 0;
    const result = await loadBotAutomationCounts(scopes, async (scope) => {
      max = Math.max(max, ++running);
      await new Promise((resolve) => setTimeout(resolve, 1));
      running--;
      if (scope.id === "2") throw new Error("Unavailable");
      return Number(scope.id);
    });
    expect(max).toBe(3); expect(result["2"]).toBeNull(); expect(result["7"]).toBe(7);
    expect(sumBotAutomationCounts(scopes, result)).toBeNull();
  });
  it("does not infer main for unresolved profiles or query unavailable runtimes", async () => {
    const read = vi.fn().mockResolvedValue(1);
    const result = await loadBotAutomationCounts([{ id: "a", status: "running" }, { id: "b", profileId: "b", status: "paused" }], read);
    expect(read).not.toHaveBeenCalled(); expect(result).toEqual({ a: null, b: null });
  });
});
