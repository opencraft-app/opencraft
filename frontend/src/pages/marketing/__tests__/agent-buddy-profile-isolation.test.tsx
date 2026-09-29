import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useBuddyProfile } from "../agent-buddy-profile";
import { buildHermesSoulContentReadCommand } from "../agent-buddy-command";
import { buildProfileMetaReadCommand } from "@/lib/hermes-profile-meta";
import type { SetupExec } from "../agent-buddy-setup-runner";

const ok = (output: string) => ({ status: "success", exitCode: 0, output });
afterEach(cleanup);

describe("Buddy profile isolation", () => {
  it.each([undefined, "", "  "])("waits for a known profile (%s), including reload", async (profileId) => {
    const exec = vi.fn<SetupExec>().mockResolvedValue(ok("Exists: no"));
    const { result, rerender } = renderHook((props: { profileId: string | undefined }) => useBuddyProfile({
      botId: `waiting-${String(profileId)}`, fallbackName: "New Bot", exec, ...props,
    }), { initialProps: { profileId } });
    act(() => result.current.reload());
    expect(exec).not.toHaveBeenCalled();
    expect(result.current.hasBuddyConfig).toBeNull();
    rerender({ profileId: "worker" });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(exec.mock.calls.map((call) => call[1])).toEqual([
      buildProfileMetaReadCommand("worker"), buildHermesSoulContentReadCommand("worker"),
    ]);
  });

  it("accepts main only when explicitly provided", async () => {
    const exec = vi.fn<SetupExec>().mockResolvedValue(ok("Exists: no"));
    const { result } = renderHook(() => useBuddyProfile({ botId: "explicit-main", profileId: "main", fallbackName: "Main", exec }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(exec.mock.calls.map((call) => call[1])).toEqual([
      buildProfileMetaReadCommand("main"), buildHermesSoulContentReadCommand("main"),
    ]);
  });

  it("does not reuse loaded or cached data for another Bot/profile or an unknown profile", async () => {
    const exec = vi.fn<SetupExec>().mockImplementation(async (_bot, command) => ok(
      command.includes("read_profile_meta") ? "__LV_META__" + JSON.stringify({ displayName: "Private name", ui_meta: { lightvela_avatar: "circle:#fff" } }) : "Exists: no",
    ));
    const props = { botId: "cache-isolation", profileId: "one" as string | undefined, fallbackName: "Fallback" };
    const { result, rerender, unmount } = renderHook((input) => useBuddyProfile({ ...input, exec }), { initialProps: props });
    await waitFor(() => expect(result.current.profile.name).toBe("Private name"));
    exec.mockRejectedValue(new Error("Unavailable"));
    for (const input of [
      { ...props, profileId: undefined },
      { ...props, profileId: "two" },
      { ...props, botId: "another-bot" },
    ]) {
      rerender(input);
      expect(result.current.profile.name).toBe("Fallback");
      expect(result.current.hasBuddyConfig).toBeNull();
      await waitFor(() => expect(result.current.loading).toBe(false));
    }
    unmount();
    const cached = renderHook(() => useBuddyProfile({ ...props, exec }));
    expect(cached.result.current.profile.name).toBe("Private name");
    await waitFor(() => expect(cached.result.current.loading).toBe(false));
  });

  it("ignores late reads after the profile changes", async () => {
    let finish!: (value: Awaited<ReturnType<SetupExec>>) => void;
    const delayed = new Promise<Awaited<ReturnType<SetupExec>>>((resolve) => { finish = resolve; });
    const exec = vi.fn<SetupExec>().mockReturnValue(delayed);
    const { result, rerender } = renderHook(({ profileId }) => useBuddyProfile({ botId: "late-read", profileId, fallbackName: "Fresh", exec }), {
      initialProps: { profileId: "old" as string | undefined },
    });
    rerender({ profileId: undefined });
    await act(async () => { finish(ok("__LV_META__" + JSON.stringify({ displayName: "Old" }))); });
    expect(result.current.profile.name).toBe("Fresh");
    expect(result.current.hasBuddyConfig).toBeNull();
    expect(result.current.loading).toBe(false);
  });
});
