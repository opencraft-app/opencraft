import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WorkspaceActionTooltip } from "@/pages/marketing/agent-settings-page";
import { ModelActionTooltip } from "@/pages/marketing/agent-model-config/model-action-tooltip";

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
  it("places collapsed navigation and Bot tooltips to the right with the shared rail style", async () => {
    vi.stubGlobal("innerHeight", 800);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.getAttribute("role") === "tooltip") return rect(0, 0, 100, 36);
      return rect(this.closest("[data-rail]")?.getAttribute("data-rail") === "bot" ? 8 : 64, 120, 40, 40);
    });

    render(<>
      <div data-rail="bot">
        <ModelActionTooltip content="Bot A · 在线" side="right" focusable={false}>
          <button type="button">Bot A</button>
        </ModelActionTooltip>
      </div>
      <div data-rail="navigation">
        <WorkspaceActionTooltip content="技能" side="right" compact focusable={false}>
          <button type="button">技能</button>
        </WorkspaceActionTooltip>
      </div>
    </>);

    fireEvent.mouseEnter(screen.getByRole("button", { name: "Bot A" }).parentElement!);
    fireEvent.mouseEnter(screen.getByRole("button", { name: "技能" }).parentElement!);
    await waitFor(() => {
      const botTooltip = screen.getByRole("tooltip", { name: "Bot A · 在线" });
      const navTooltip = screen.getByRole("tooltip", { name: "技能" });
      expect(botTooltip).toHaveClass("lv-agent-rail-tooltip");
      expect(navTooltip).toHaveClass("lv-agent-rail-tooltip");
      expect(botTooltip).toHaveStyle({ left: "56px", top: "140px" });
      expect(navTooltip).toHaveStyle({ left: "112px", top: "140px" });
      expect(botTooltip.parentElement).toBe(document.body);
      expect(navTooltip.parentElement).toBe(document.body);
    });
  });

  it("shows a disabled Chat tab explanation outside the clipped sidebar", async () => {
    vi.stubGlobal("innerWidth", 320);
    const sidebar = document.createElement("div");
    sidebar.style.overflow = "hidden";
    document.body.appendChild(sidebar);

    let trigger: HTMLElement | null = null;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this === trigger) return rect(130, 280, 110, 35);
      if (this.getAttribute("role") === "tooltip") return rect(0, 0, 288, 48);
      return rect(0, 0, 0, 0);
    });

    const { unmount } = render(
      <WorkspaceActionTooltip content="Chat is currently available only for the main Bot" side="bottom" className="flex w-full rounded-full">
        <button type="button" role="tab" disabled>Chat</button>
      </WorkspaceActionTooltip>,
      { container: sidebar },
    );

    const button = screen.getByRole("tab", { name: "Chat" });
    trigger = button.parentElement;
    expect(button).toBeDisabled();
    expect(trigger).toHaveClass("w-full", "rounded-full");

    fireEvent.mouseEnter(trigger!);
    const tooltip = await screen.findByRole("tooltip");
    await waitFor(() => expect(tooltip).toHaveStyle({ left: "160px", top: "323px" }));
    expect(tooltip.parentElement).toBe(document.body);
    expect(tooltip).toHaveTextContent("Chat is currently available only for the main Bot");
    expect(trigger).toHaveAttribute("aria-describedby", tooltip.id);

    fireEvent.keyDown(trigger!, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.focus(trigger!);
    expect(screen.getByRole("tooltip")).toBeInTheDocument();

    unmount();
    sidebar.remove();
  });

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
