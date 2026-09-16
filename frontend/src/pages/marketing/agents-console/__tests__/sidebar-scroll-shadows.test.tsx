import { useEffect, type ReactNode } from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentConsoleShell } from "../console-shell";

let viewportHeight = 200;
let contentHeight = 200;
const observers: TestResizeObserver[] = [];
class TestResizeObserver implements ResizeObserver {
  readonly targets = new Set<Element>();
  constructor(private readonly callback: ResizeObserverCallback) { observers.push(this); }
  observe = vi.fn((target: Element) => { this.targets.add(target); });
  unobserve = vi.fn((target: Element) => { this.targets.delete(target); });
  disconnect = vi.fn(() => { this.targets.clear(); });
  notify() { this.callback([], this); }
}
beforeEach(() => {
  viewportHeight = 200; contentHeight = 200; observers.length = 0;
  vi.stubGlobal("ResizeObserver", TestResizeObserver);
  // jsdom has no layout. Supply only browser measurements; the production
  // component still owns scrolling, observer subscriptions and shadow state.
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("lv-agents-sidebar-middle") ? viewportHeight : 0;
  });
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("lv-agents-sidebar-middle") ? contentHeight : 0;
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function shell({ desktop = true, navigation = <nav>Sections</nav>, children = <p>Heavy content</p> }: { desktop?: boolean; navigation?: ReactNode; children?: ReactNode } = {}) {
  return <AgentConsoleShell desktop={desktop} navigationOpen={false} onNavigationOpenChange={vi.fn()} title="Models" navigationLabel="Navigation" closeLabel="Close navigation"
    profile={<button>Current Agent</button>} footer={<button>Account</button>} navigation={navigation}>{children}</AgentConsoleShell>;
}
const sidebar = () => screen.getByRole("complementary");
function middle() { return document.querySelector<HTMLDivElement>(".lv-agents-sidebar-middle")!; }
function expectEdges(above: boolean, below: boolean) {
  expect(sidebar()).toHaveAttribute("data-scroll-above", String(above));
  expect(sidebar()).toHaveAttribute("data-scroll-below", String(below));
}

describe("desktop sidebar scroll shadows", () => {
  it("shows neither shadow for initial non-overflowing content", () => {
    render(shell());
    expectEdges(false, false);
  });

  it("shows bottom only at the start, both in the middle, and top only at the end", () => {
    contentHeight = 500;
    render(shell());
    expectEdges(false, true);
    middle().scrollTop = 120;
    fireEvent.scroll(middle());
    expectEdges(true, true);
    middle().scrollTop = 300;
    fireEvent.scroll(middle());
    expectEdges(true, false);
  });

  it("uses a one-pixel boundary tolerance without changing the scroll position", () => {
    contentHeight = 500; render(shell());
    middle().scrollTop = 0.9; fireEvent.scroll(middle()); expectEdges(false, true);
    middle().scrollTop = 299.2; fireEvent.scroll(middle()); expectEdges(true, false);
    expect(middle().scrollTop).toBe(299.2);
    middle().scrollTop = -2; fireEvent.scroll(middle()); expectEdges(false, true);
    contentHeight = 200.9; act(() => observers[0]?.notify()); expectEdges(false, false);
  });

  it("observes content growth and shrinkage even when the viewport size does not change", () => {
    const view = render(shell());
    const observedContent = middle().firstElementChild;
    expect(observers[0]?.targets.has(middle())).toBe(true);
    expect(observers[0]?.targets.has(observedContent!)).toBe(true);
    contentHeight = 600;
    view.rerender(shell({ navigation: <nav>Many asynchronously loaded sessions</nav> }));
    act(() => observers[0]?.notify());
    expectEdges(false, true);
    middle().scrollTop = 400; fireEvent.scroll(middle()); expectEdges(true, false);
    contentHeight = 800; act(() => observers[0]?.notify()); expectEdges(true, true);
    contentHeight = 100;
    view.rerender(shell({ navigation: <nav>One remaining session</nav> }));
    act(() => observers[0]?.notify());
    expectEdges(false, false);
  });

  it("recomputes edges when the scroll viewport is resized", () => {
    contentHeight = 500; render(shell()); expectEdges(false, true);
    viewportHeight = 600; act(() => observers[0]?.notify()); expectEdges(false, false);
    viewportHeight = 100; fireEvent(window, new Event("resize")); expectEdges(false, true);
  });

  it("cleans desktop observers and listeners across mobile switches and unmount without remounting heavy content", () => {
    const mounted = vi.fn(); const unmounted = vi.fn();
    function HeavyContent() { useEffect(() => { mounted(); return unmounted; }, []); return <p>Heavy content</p>; }
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    contentHeight = 500;
    const view = render(shell({ children: <HeavyContent /> }));
    const oldMiddle = middle();
    const removeScroll = vi.spyOn(oldMiddle, "removeEventListener");
    const oldObserver = observers[0]!;
    expectEdges(false, true);
    view.rerender(shell({ desktop: false, children: <HeavyContent /> }));
    expect(oldObserver.disconnect).toHaveBeenCalledTimes(1);
    expect(removeScroll).toHaveBeenCalledWith("scroll", expect.any(Function));
    const resizeListener = add.mock.calls.find(([name]) => name === "resize")?.[1];
    expect(remove).toHaveBeenCalledWith("resize", resizeListener);
    expect(screen.getByRole("button", { name: "Navigation" })).toBeVisible();
    expect(document.querySelector(".lv-agents-sidebar-middle")).toBeNull();
    expectEdges(false, false);
    contentHeight = 100;
    view.rerender(shell({ children: <HeavyContent /> }));
    expectEdges(false, false);
    act(() => oldObserver.notify());
    expectEdges(false, false);
    expect(screen.getAllByRole("navigation")).toHaveLength(1);
    expect(mounted).toHaveBeenCalledTimes(1); expect(unmounted).not.toHaveBeenCalled();
    view.unmount();
    expect(observers[1]?.disconnect).toHaveBeenCalledTimes(1);
    expect(unmounted).toHaveBeenCalledTimes(1);
  });

  it("does not introduce focus stops or intercept the fixed slot controls", async () => {
    contentHeight = 500; render(shell());
    middle().scrollTop = 100; fireEvent.scroll(middle()); expectEdges(true, true);
    await userEvent.tab(); expect(screen.getByRole("button", { name: "Current Agent" })).toHaveFocus();
    await userEvent.tab(); expect(screen.getByRole("button", { name: "Account" })).toHaveFocus();
    expect(screen.getAllByRole("button")).toHaveLength(2);
  });

  it("uses non-interactive unanimated pseudo-elements in the existing 12px desktop gaps", () => {
    const css = readFileSync(join(process.cwd(), "src/styles.css"), "utf8");
    const top = css.match(/\.lv-agents-sidebar\[data-scroll-above="true"\] \.lv-agents-sidebar-profile::after\s*\{([^}]+)\}/)?.[1];
    const bottom = css.match(/\.lv-agents-sidebar\[data-scroll-below="true"\] \.lv-agents-sidebar-footer::before\s*\{([^}]+)\}/)?.[1];
    expect(top).toContain("top: 100%;"); expect(bottom).toContain("bottom: 100%;");
    for (const selector of [".lv-agents-sidebar-profile::after", ".lv-agents-sidebar-footer::before"]) {
      expect(css).toContain(selector);
    }
    const shared = css.match(/\.lv-agents-sidebar-footer::before\s*\{([^}]+)\}/)?.[1];
    expect(shared).toContain("height: 12px;");
    expect(shared).toContain("pointer-events: none;");
    expect(`${shared}${top}${bottom}`).not.toMatch(/animation|transition/);
  });
});
