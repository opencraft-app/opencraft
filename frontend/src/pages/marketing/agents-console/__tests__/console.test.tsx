import { useEffect, useState } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AgentConsoleShell, ConsoleBotProfile, ConsoleSidebarTabs, ConsoleConfirmDialog, ConsoleTooltip } from "../index";

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Agents console presentation", () => {
  it("places the desktop profile and account outside the single scrollable navigation region", () => {
    render(<AgentConsoleShell desktop navigationOpen={false} onNavigationOpenChange={vi.fn()} title="Models" navigationLabel="Navigation" closeLabel="Close navigation"
      profile={<button>Current bot</button>} footer={<button>Account</button>}
      navigation={<nav aria-label="Sections">{Array.from({ length: 50 }, (_, index) => <a key={index} href={`#section-${index}`}>Section {index}</a>)}</nav>}><div>Heavy content</div></AgentConsoleShell>);
    const navigation = screen.getByRole("navigation", { name: "Sections" });
    const middle = navigation.closest(".lv-agents-sidebar-middle");
    expect(middle).not.toBeNull();
    expect(screen.getByRole("button", { name: "Current bot" }).closest(".lv-agents-sidebar-profile")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Account" }).closest(".lv-agents-sidebar-footer")).not.toBeNull();
    expect(middle).not.toContainElement(screen.getByRole("button", { name: "Current bot" }));
    expect(middle).not.toContainElement(screen.getByRole("button", { name: "Account" }));
    expect(screen.getAllByRole("navigation")).toHaveLength(1);
    expect(screen.getAllByRole("link")).toHaveLength(50);
  });

  it("lets exploration navigation retain its content height while chat keeps its shrinkable scroll chain", () => {
    const props = { canChat: true, label: "Sidebar", settingsLabel: "Explore", chatLabel: "Chat", unavailableLabel: "", onSettings: vi.fn(), onChat: vi.fn() };
    const view = render(<TooltipProvider><ConsoleSidebarTabs {...props} value="settings"><nav>Long navigation</nav></ConsoleSidebarTabs></TooltipProvider>);
    // jsdom has no layout: enforce the flex contract; real overflow is checked in-browser.
    expect(screen.getByRole("tabpanel").parentElement).toHaveClass("shrink-0");
    view.rerender(<TooltipProvider><ConsoleSidebarTabs {...props} value="chat"><div>Sessions</div></ConsoleSidebarTabs></TooltipProvider>);
    expect(screen.getByRole("tabpanel").parentElement).toHaveClass("min-h-0");
    expect(screen.getByRole("tabpanel").parentElement).not.toHaveClass("shrink-0");
  });

  it("uses the sidebar-only B treatment without double borders or extra animation", () => {
    const props = { canChat: true, label: "Sidebar", settingsLabel: "Explore", chatLabel: "Chat", unavailableLabel: "", onSettings: vi.fn(), onChat: vi.fn() };
    const view = render(<TooltipProvider><ConsoleSidebarTabs {...props} value="settings">Navigation</ConsoleSidebarTabs></TooltipProvider>);
    expect(screen.getByRole("tablist")).toHaveClass("h-10", "p-1", "gap-1", "rounded-md", "border-0", "bg-[var(--agent-tabs-track,#f3f3f1)]", "shadow-none");
    expect(screen.getByRole("tablist")).not.toHaveClass("border");
    for (const tab of screen.getAllByRole("tab")) {
      expect(tab).toHaveClass("h-full", "rounded-sm", "border-0", "bg-transparent", "py-0", "text-sm", "font-medium", "transition-none", "data-[state=active]:bg-[var(--agent-tabs-selected,#fff)]", "data-[state=active]:shadow-sm", "focus-visible:ring-2", "focus-visible:ring-offset-2");
      expect(tab).not.toHaveClass("border", "transition", "data-[state=active]:shadow-none");
    }
    expect(screen.getByRole("tab", { name: "Explore" })).toHaveAttribute("aria-controls", screen.getByRole("tabpanel").id);
    view.rerender(<TooltipProvider><ConsoleSidebarTabs {...props} value="chat">Sessions</ConsoleSidebarTabs></TooltipProvider>);
    expect(screen.getByRole("tab", { name: "Chat" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Chat" })).toHaveAttribute("aria-controls", screen.getByRole("tabpanel").id);
  });

  it("constrains the unavailable Chat tooltip wrapper to the tab list's inner height", () => {
    render(<TooltipProvider><ConsoleSidebarTabs value="settings" canChat={false} label="Sidebar" settingsLabel="Explore" chatLabel="Chat" unavailableLabel="Main bot only" onSettings={vi.fn()} onChat={vi.fn()}>Navigation</ConsoleSidebarTabs></TooltipProvider>);
    const chat = screen.getByRole("tab", { name: "Chat" });
    expect(chat).toBeDisabled();
    expect(chat.parentElement).toHaveClass("h-full", "min-h-0");
    expect(chat).toHaveClass("h-full", "py-0");
  });

  it("keeps unavailable Chat explained and inactive for pointer and keyboard input", async () => {
    const chatIntent = vi.fn();
    const user = userEvent.setup();
    render(<TooltipProvider delayDuration={0}><ConsoleSidebarTabs value="settings" canChat={false} label="Sidebar" settingsLabel="Explore" chatLabel="Chat" unavailableLabel="Main bot only" onSettings={vi.fn()} onChat={chatIntent}>Navigation</ConsoleSidebarTabs></TooltipProvider>);
    const chat = screen.getByRole("tab", { name: "Chat" });
    expect(chat).toHaveAccessibleDescription("Main bot only");
    await user.click(chat);
    await user.click(screen.getByRole("tab", { name: "Explore" }));
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Explore" })).toHaveAttribute("aria-selected", "true");
    await user.tab();
    expect(chat.parentElement).toHaveFocus();
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Main bot only");
    await user.keyboard("{Enter}");
    expect(chatIntent).not.toHaveBeenCalled();
    expect(chat).toHaveAttribute("aria-selected", "false");
  });

  it("gives enabled tooltip buttons one tab stop and disabled reasons a focusable stop", async () => {
    const user = userEvent.setup();
    render(<TooltipProvider delayDuration={0}><ConsoleTooltip content="Enabled help"><button>Enabled</button></ConsoleTooltip><ConsoleTooltip content="Disabled reason"><button disabled>Disabled</button></ConsoleTooltip><button>Next</button></TooltipProvider>);
    await user.tab();
    expect(screen.getByRole("button", { name: "Enabled" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Disabled" }).parentElement).toHaveFocus();
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Disabled reason");
    await user.tab();
    expect(screen.getByRole("button", { name: "Next" })).toHaveFocus();
  });
  it("keeps heavy content mounted when opening mobile navigation and resizing", async () => {
    const mounted = vi.fn();
    const unmounted = vi.fn();
    function Content() {
      useEffect(() => { mounted(); return unmounted; }, []);
      return <div>Heavy content</div>;
    }
    function Shell({ desktop }: { desktop: boolean }) {
      const [open, setOpen] = useState(false);
      return <AgentConsoleShell desktop={desktop} navigationOpen={open} onNavigationOpenChange={setOpen} title="Models" navigationLabel="Navigation" closeLabel="Close navigation" profile={<p>Current bot</p>} navigation={<nav aria-label="Sections"><a href="#models">Model settings</a></nav>}><Content /></AgentConsoleShell>;
    }
    const view = render(<Shell desktop={false} />);
    expect(screen.getByText("Current bot")).toBeVisible();
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Navigation" }));
    expect(screen.getAllByRole("navigation")).toHaveLength(1);
    expect(screen.getByRole("dialog", { name: "Navigation" })).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.getByRole("button", { name: "Navigation" })).toHaveFocus());
    view.rerender(<Shell desktop />);
    expect(screen.getAllByRole("navigation")).toHaveLength(1);
    expect(mounted).toHaveBeenCalledTimes(1);
    expect(unmounted).not.toHaveBeenCalled();
  });

  it("selects a Bot by keyboard while maintenance buttons remain independent", async () => {
    const select = vi.fn();
    const restart = vi.fn();
    const user = userEvent.setup();
    function Profile() {
      const [open, setOpen] = useState(false);
      return <ConsoleBotProfile name="Main bot" avatarUrl="/avatar.png" status={<span>Running</span>} options={[{ id: "main", label: "Main bot" }, { id: "other", label: "Other bot" }]} selectedId="main" open={open} onOpenChange={setOpen} onSelect={select} actions={<button onClick={restart}>Restart</button>} />;
    }
    render(<Profile />);
    expect(document.querySelector("button button")).toBeNull();
    const name = screen.getByText("Main bot");
    const status = screen.getByText("Running");
    expect(name.parentElement).toContainElement(status);
    const switcher = screen.getByRole("button", { name: "Main bot" });
    expect(screen.getByRole("button", { name: "Restart" }).compareDocumentPosition(switcher) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await user.tab();
    expect(screen.getByRole("button", { name: "Restart" })).toHaveFocus();
    await user.tab();
    expect(switcher).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("menu")).toBeInTheDocument();
    await user.keyboard("{ArrowDown}{Enter}");
    expect(select).toHaveBeenCalledExactlyOnceWith("other");
    await waitFor(() => expect(screen.getByRole("button", { name: "Main bot" })).toHaveFocus());
    await user.click(screen.getByRole("button", { name: "Restart" }));
    expect(restart).toHaveBeenCalledTimes(1);
    expect(select).toHaveBeenCalledTimes(1);
  });

  it("fires one tab intent for both a changed and already selected tab", async () => {
    const settings = vi.fn();
    const chat = vi.fn();
    function Tabs() {
      const [value, setValue] = useState<"settings" | "chat">("settings");
      return <TooltipProvider><ConsoleSidebarTabs value={value} canChat label="Sidebar view" settingsLabel="Explore" chatLabel="Chat" unavailableLabel="Main bot only" onSettings={() => { settings(); setValue("settings"); }} onChat={() => { chat(); setValue("chat"); }}>Content</ConsoleSidebarTabs></TooltipProvider>;
    }
    render(<Tabs />);
    await userEvent.click(screen.getByRole("tab", { name: "Chat" }));
    expect(chat).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("tab", { name: "Chat" }));
    expect(chat).toHaveBeenCalledTimes(2);
    await userEvent.click(screen.getByRole("tab", { name: "Explore" }));
    expect(settings).toHaveBeenCalledTimes(1);
    await userEvent.keyboard("{Enter}");
    expect(settings).toHaveBeenCalledTimes(2);
    await userEvent.keyboard(" ");
    expect(settings).toHaveBeenCalledTimes(3);
    await userEvent.keyboard("{ArrowRight}");
    await waitFor(() => expect(chat).toHaveBeenCalledTimes(3));
  });

  it("keeps a pending maintenance confirmation open and returns focus after host close", async () => {
    const confirm = vi.fn();
    let finish: () => void = () => undefined;
    const pendingOperation = new Promise<void>((resolve) => { finish = resolve; });
    function Confirmation() {
      const [open, setOpen] = useState(false);
      const [pending, setPending] = useState(false);
      return <><button onClick={() => setOpen(true)}>Reset</button><ConsoleConfirmDialog open={open} onOpenChange={setOpen} title="Reset model" description="Configuration will be replaced" confirmLabel="Confirm" cancelLabel="Cancel" pending={pending} onConfirm={async () => { confirm(); setPending(true); await pendingOperation; setPending(false); setOpen(false); }} /></>;
    }
    render(<Confirmation />);
    await userEvent.click(screen.getByRole("button", { name: "Reset" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(confirm).toHaveBeenCalledTimes(1);
    await userEvent.keyboard("{Escape}");
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    await act(async () => { finish(); await pendingOperation; });
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole("button", { name: "Reset" })).toHaveFocus());
  });
});
