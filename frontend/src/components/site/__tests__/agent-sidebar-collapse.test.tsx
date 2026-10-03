import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentSidebarToggle, useAgentSidebarCollapse } from "@/components/site/agent-sidebar";

vi.mock("@/i18n/t", () => ({ useT: () => (text: string) => text }));

describe("Agent sidebar collapse", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(cleanup);

  it("persists the desktop navigation choice across remounts", async () => {
    const first = renderHook(() => useAgentSidebarCollapse());
    expect(first.result.current.collapsed).toBe(false);

    act(() => first.result.current.toggle());
    expect(first.result.current.collapsed).toBe(true);
    expect(window.localStorage.getItem("lv-agent-sidebar-collapsed")).toBe("true");
    first.unmount();

    const second = renderHook(() => useAgentSidebarCollapse());
    await waitFor(() => expect(second.result.current.collapsed).toBe(true));
  });

  it("labels the icon button for its next action and keyboard access", () => {
    const onToggle = vi.fn();
    const { rerender } = render(<AgentSidebarToggle collapsed={false} onToggle={onToggle} />);
    const button = screen.getByRole("button", { name: "收起导航" });
    expect(button).toHaveAttribute("data-tooltip", "收起导航");
    expect(button).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(button);
    expect(onToggle).toHaveBeenCalledOnce();

    rerender(<AgentSidebarToggle collapsed onToggle={onToggle} />);
    expect(screen.getByRole("button", { name: "展开导航" })).toHaveAttribute("aria-expanded", "false");
  });
});
