import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSidebar } from "../agent-sidebar";
import { AgentSettingsLoadingContent } from "@/pages/marketing/agent-settings-loading-view";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Agent sidebar scrolling", () => {
  it("keeps loading tabs outside the scroll area and omits the standalone feedback placeholder", () => {
    const { container } = render(<AgentSettingsLoadingContent />);
    const tabs = container.querySelector(".lv-agents-sidebar-tabs");
    const middle = container.querySelector(".lv-agents-sidebar-middle");
    expect(tabs).not.toBeNull();
    expect(middle).not.toContainElement(tabs as HTMLElement);
    expect(container.querySelector(".lv-agent-feedback-link")).toBeNull();
  });
  it("matches the multi Bot rail and chat canvas while data is loading", () => {
    const { container } = render(<AgentSettingsLoadingContent multiBotEnabled isChat />);
    expect(screen.getByTestId("agent-bot-rail-skeleton")).toBeInTheDocument();
    expect(screen.getByTestId("agent-chat-loading-canvas")).toBeInTheDocument();
    expect(container.querySelector(".lv-agents-sidebar-profile")).toHaveClass("lg:hidden");
    expect(container.querySelector(".lv-agent-settings-content")).toHaveClass("lg:col-start-3");
    expect(container.querySelectorAll(".lv-agents-nav-item")).toHaveLength(4);
  });
  it("uses the narrow grid when the loading sidebar is collapsed", () => {
    const { container } = render(<AgentSettingsLoadingContent multiBotEnabled isChat collapsed />);
    expect(screen.getByTestId("agent-settings-loading-content")).toHaveClass("lg:grid-cols-[56px_56px_minmax(0,1fr)]");
    expect(container.querySelector(".lv-agents-sidebar-profile")).toHaveClass("lg:hidden");
  });
  it("updates both edges on scroll and content resize, keeping profile and account outside the scroll area", () => {
    let resize: () => void = () => {};
    const disconnect = vi.fn();
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: () => void) { resize = callback; }
      observe() {}
      disconnect = disconnect;
    });
    const { unmount } = render(<AgentSidebar>
      <div className="lv-agents-sidebar-profile">Bot profile</div>
      <div className="lv-agents-sidebar-middle" data-testid="middle"><div>Navigation</div></div>
      <div className="lv-agents-sidebar-footer">Account</div>
    </AgentSidebar>);
    const sidebar = screen.getByRole("complementary");
    const middle = screen.getByTestId("middle");
    expect(middle).not.toContainElement(screen.getByText("Bot profile"));
    expect(middle).not.toContainElement(screen.getByText("Account"));
    expect(sidebar).toHaveAttribute("data-scroll-below", "false");
    Object.defineProperties(middle, {
      scrollHeight: { configurable: true, value: 700 },
      clientHeight: { configurable: true, value: 300 },
    });
    act(resize);
    expect(sidebar).toHaveAttribute("data-scroll-above", "false");
    expect(sidebar).toHaveAttribute("data-scroll-below", "true");
    middle.scrollTop = 200;
    fireEvent.scroll(middle);
    expect(sidebar).toHaveAttribute("data-scroll-above", "true");
    expect(sidebar).toHaveAttribute("data-scroll-below", "true");
    middle.scrollTop = 399.5;
    fireEvent.scroll(middle);
    expect(sidebar).toHaveAttribute("data-scroll-below", "false");
    Object.defineProperty(middle, "scrollHeight", { value: 300 });
    act(resize);
    expect(sidebar).toHaveAttribute("data-scroll-above", "false");
    expect(sidebar).toHaveAttribute("data-scroll-below", "false");
    unmount();
    expect(disconnect).toHaveBeenCalledOnce();
  });
});
