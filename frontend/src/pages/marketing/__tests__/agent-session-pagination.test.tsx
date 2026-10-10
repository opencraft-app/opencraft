import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useAgentSessionPagination } from "@/pages/marketing/agent-session-pagination";

const sessions = (count: number) => Array.from({ length: count }, (_, index) => ({
  chatId: `session-${index + 1}`,
  updatedAt: index + 1,
}));

describe("agent session pagination", () => {
  it("shows the latest 5 first, then expands and collapses 5 at a time", async () => {
    const { result } = renderHook(() => useAgentSessionPagination(sessions(13), false, undefined, 5));
    expect(result.current.visibleSessions).toHaveLength(5);
    expect(result.current.visibleSessions[0]?.chatId).toBe("session-13");
    expect(result.current.hasExpanded).toBe(false);

    await act(async () => { await result.current.showMore(); });
    expect(result.current.visibleSessions).toHaveLength(10);
    expect(result.current.hasMoreVisible).toBe(true);
    expect(result.current.hasExpanded).toBe(true);

    await act(async () => { await result.current.showMore(); });
    expect(result.current.visibleSessions).toHaveLength(13);
    expect(result.current.hasMoreVisible).toBe(false);

    act(() => { result.current.collapse(); });
    expect(result.current.visibleSessions).toHaveLength(10);
    expect(result.current.hasMoreVisible).toBe(true);
    act(() => { result.current.collapse(); });
    expect(result.current.visibleSessions).toHaveLength(5);
    expect(result.current.hasExpanded).toBe(false);
  });

  it("shows more only when there are more than 5 loaded sessions", () => {
    const { result, rerender } = renderHook(
      ({ count }) => useAgentSessionPagination(sessions(count), false, undefined, 5),
      { initialProps: { count: 5 } },
    );
    expect(result.current.visibleSessions).toHaveLength(5);
    expect(result.current.hasMoreVisible).toBe(false);
    rerender({ count: 6 });
    expect(result.current.visibleSessions).toHaveLength(5);
    expect(result.current.hasMoreVisible).toBe(true);
  });

  it("requests the next server page before showing beyond the loaded sessions", async () => {
    const loadMore = vi.fn(async () => undefined);
    const { result, rerender } = renderHook(
      ({ count, hasMore }) => useAgentSessionPagination(sessions(count), hasMore, loadMore, 5),
      { initialProps: { count: 5, hasMore: true } },
    );
    await act(async () => { await result.current.showMore(); });
    expect(loadMore).toHaveBeenCalledOnce();
    expect(result.current.visibleSessions).toHaveLength(5);
    rerender({ count: 12, hasMore: false });
    expect(result.current.visibleSessions).toHaveLength(10);
    await act(async () => { await result.current.showMore(); });
    expect(loadMore).toHaveBeenCalledOnce();
    expect(result.current.visibleSessions).toHaveLength(12);
    act(() => { result.current.reset(); });
    expect(result.current.visibleSessions).toHaveLength(5);
  });

  it("keeps the visible count when the server page fails", async () => {
    const { result } = renderHook(() => useAgentSessionPagination(sessions(30), true, async () => {
      throw new Error("offline");
    }));
    await act(async () => { await result.current.showMore(); });
    expect(result.current.visibleSessions).toHaveLength(20);
    expect(result.current.pageError).toBe(true);
    expect(result.current.loadingMore).toBe(false);
  });

  it("keeps old pinned conversations visible without consuming recent slots", async () => {
    const oldPinned = { chatId: "old-pinned", updatedAt: 1, pinned: true };
    const recent = sessions(8).map((session) => ({ ...session, pinned: false }));
    const { result } = renderHook(() => useAgentSessionPagination([...recent, oldPinned], false, undefined, 5));

    expect(result.current.pinnedCount).toBe(1);
    expect(result.current.visibleSessions.map((session) => session.chatId)).toEqual([
      "old-pinned", "session-8", "session-7", "session-6", "session-5", "session-4",
    ]);
    await act(async () => { await result.current.showMore(); });
    expect(result.current.visibleSessions).toHaveLength(9);
    act(() => { result.current.collapse(); });
    expect(result.current.visibleSessions).toHaveLength(6);
  });

  it("loads the server page on the first click when pinned sessions fill the local threshold", async () => {
    const loadMore = vi.fn(async () => undefined);
    const recent = sessions(8).map((session) => ({ ...session, pinned: false }));
    const pinned = ["pinned-1", "pinned-2"].map((chatId) => ({ chatId, pinned: true }));
    const { result } = renderHook(() => useAgentSessionPagination([...recent, ...pinned], true, loadMore, 5));

    await act(async () => { await result.current.showMore(); });

    expect(loadMore).toHaveBeenCalledOnce();
    expect(result.current.visibleSessions).toHaveLength(10);
  });
});
