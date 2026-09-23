import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WorkspaceActionTooltip } from "@/pages/marketing/agent-settings-page";

const rect = (left: number, top: number, width: number, height: number): DOMRect => ({
  x: left,
  y: top,
  left,
  top,
  right: left + width,
  bottom: top + height,
  width,
  height,
  toJSON: () => ({}),
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Agent sidebar action tooltip", () => {
  it("escapes the clipping sidebar and stays inside the viewport", async () => {
    vi.stubGlobal("innerWidth", 320);
    const sidebar = document.createElement("div");
    sidebar.style.overflow = "hidden";
    document.body.appendChild(sidebar);

    let trigger: HTMLElement | null = null;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this === trigger) return rect(292, 20, 24, 24);
      if (this.getAttribute("role") === "tooltip") return rect(0, 0, 170, 24);
      return rect(0, 0, 0, 0);
    });

    const onClick = vi.fn();
    const onParentKeyDown = vi.fn();
    const { unmount } = render(
      <div onKeyDown={onParentKeyDown}>
        <WorkspaceActionTooltip content="删除整个 Agent" side="bottom" compact focusable={false}>
          <button type="button" aria-label="删除整个 Agent" onClick={onClick}>删除</button>
        </WorkspaceActionTooltip>
      </div>,
      { container: sidebar },
    );

    const button = screen.getByRole("button", { name: "删除整个 Agent" });
    trigger = button.parentElement;
    expect(trigger).not.toHaveAttribute("tabindex");
    fireEvent.mouseEnter(trigger!);

    const tooltip = await screen.findByRole("tooltip");
    await waitFor(() => expect(tooltip).toHaveStyle({ left: "219px", top: "52px" }));
    expect(tooltip.parentElement).toBe(document.body);
    expect(tooltip).toHaveClass("fixed");

    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
    fireEvent.keyDown(trigger!, { key: "Enter" });
    fireEvent.keyDown(trigger!, { key: " " });
    expect(onParentKeyDown).not.toHaveBeenCalled();
    fireEvent.keyDown(trigger!, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.focus(button);
    expect(await screen.findByRole("tooltip")).toHaveTextContent("删除整个 Agent");

    unmount();
    sidebar.remove();
  });
});
