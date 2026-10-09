import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_HERMES_APPEARANCE, getLegacyHermesAppearance } from "@/lib/hermes-appearance";
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

  it("keeps saved appearance when the optional legacy SOUL read fails, including reload", async () => {
    const appearance = { ...DEFAULT_HERMES_APPEARANCE, shape: 'drop', skin: 'mint', doodads: ['bucket-hat', 'book'] };
    const exec = vi.fn<SetupExec>().mockImplementation(async (_bot, command) => {
      if (command === buildProfileMetaReadCommand('worker')) return ok('__LV_META__' + JSON.stringify({ displayName: 'My Agent', ui_meta: { lightvela_appearance: appearance } }));
      throw new Error('SOUL unavailable');
    });
    const { result, unmount } = renderHook(() => useBuddyProfile({ botId: 'appearance-without-soul', profileId: 'worker', fallbackName: 'Fallback', exec }));
    await waitFor(() => expect(result.current.profile.appearance).toEqual(appearance));
    expect(result.current.hasBuddyConfig).toBe(true);
    expect(result.current.soulExists).toBeNull();
    unmount();
    const refreshed = renderHook(() => useBuddyProfile({ botId: 'appearance-without-soul', profileId: 'worker', fallbackName: 'Fallback', exec }));
    await waitFor(() => expect(refreshed.result.current.profile.appearance).toEqual(appearance));
    expect(refreshed.result.current.profile.name).toBe('My Agent');
  });

  it("assigns stable new looks to legacy profiles without completing onboarding", async () => {
    const exec = vi.fn<SetupExec>().mockResolvedValue(ok("Exists: no"));
    const props = { botId: "legacy-empty", profileId: "worker", fallbackName: "Legacy", exec };
    const { result, unmount } = renderHook(() => useBuddyProfile(props));
    const expected = result.current.profile.appearance;
    expect(expected?.style).toBe("doodle");
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.profile.appearance).toEqual(expected);
    expect(result.current.hasBuddyConfig).toBe(false);
    unmount();
    const refreshed = renderHook(() => useBuddyProfile(props));
    expect(refreshed.result.current.profile.appearance).toEqual(expected);
    await waitFor(() => expect(refreshed.result.current.loading).toBe(false));
    expect(exec.mock.calls.every((call) => [buildProfileMetaReadCommand("worker"), buildHermesSoulContentReadCommand("worker")].includes(call[1]))).toBe(true);
  });

  it("replaces old geometric metadata while keeping the configured name", async () => {
    const exec = vi.fn<SetupExec>().mockImplementation(async (_bot, command) => ok(
      command.includes("read_profile_meta") ? "__LV_META__" + JSON.stringify({ displayName: "Legacy name", ui_meta: { lightvela_avatar: "circle:#fff" } }) : "Exists: no",
    ));
    const { result } = renderHook(() => useBuddyProfile({ botId: "legacy-geometric", profileId: "worker", fallbackName: "Fallback", exec }));
    await waitFor(() => expect(result.current.profile.name).toBe("Legacy name"));
    expect(result.current.profile.appearance?.style).toBe("doodle");
    expect(result.current.hasBuddyConfig).toBe(true);
    expect(new Set(Array.from({ length: 30 }, (_, index) => JSON.stringify(getLegacyHermesAppearance(`bot-${index}`)))).size).toBe(7);
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
