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
});
