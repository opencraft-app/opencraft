import { useState } from "react";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SidebarUserMenu, type SidebarUserMenuProps } from "../sidebar-user-menu";
import { InternationalLanguageMenu } from "../language-switcher";

beforeEach(() => vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const data: Omit<SidebarUserMenuProps, "open" | "onOpenChange"> = {
  name: "Agent Owner", email: "owner@example.com", avatarSrc: "/avatar.png", planLabel: "Plan: Pro",
  credit: { state: "ready", total: 1000, used: 250, usedPercent: 25, label: "Credits used" },
  upgrade: { href: "/subscribe/?upgrade_pass_id=p%2F1", label: "Upgrade plan" },
  entries: [{ id: "agents", kind: "agent", href: "/agents", label: "My AI Companion" }, { id: "account", kind: "account", href: "/account", label: "Account Settings" }],
  labels: { trigger: "Open user menu", menu: "Account menu", logout: "Sign out", language: "Language" },
  onSignOut: vi.fn(),
};
function Fixture(props: Partial<typeof data> = {}) {
  const [open, setOpen] = useState(false);
  return <div data-testid="clipped-sidebar" style={{ overflow: "hidden", height: 40 }}><SidebarUserMenu {...data} {...props} open={open} onOpenChange={setOpen} /></div>;
}

describe("sidebar user menu presentation", () => {
  it("opens from every part of the account row, including hover", async () => {
    const user = userEvent.setup();
    render(<Fixture />);
    const trigger = screen.getByRole("button", { name: "Open user menu" });
    await user.hover(trigger);
    expect(await screen.findByRole("dialog", { name: "Account menu" })).toBeVisible();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    const targets = [trigger.querySelector("img")!, screen.getByText("Agent Owner"),
      screen.getByText("Plan: Pro"), trigger.querySelector("svg")!, trigger];
    for (const target of targets) {
      await user.click(target);
      expect(await screen.findByRole("dialog", { name: "Account menu" })).toBeVisible();
      await user.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    }
  });
  it.each([
    { used: 0, total: 4500, usedPercent: 0, expected: 0 },
    { used: 250, total: 1000, usedPercent: 25, expected: 25 },
    { used: 1000, total: 1000, usedPercent: 100, expected: 100 },
    { used: 1200, total: 1000, usedPercent: 120, expected: 100 },
    { used: 0, total: 1000, usedPercent: -5, expected: 0 },
  ])("shows $used / $total as supporting text above a shared Progress ($usedPercent%)", async ({ used, total, usedPercent, expected }) => {
    render(<Fixture credit={{ state: "ready", label: "Credits used", used, total, usedPercent }} />);
    await userEvent.click(screen.getByRole("button", { name: "Open user menu" }));
    const progress = screen.getByRole("progressbar", { name: "Credits used" });
    const amount = `${used.toLocaleString()} / ${total.toLocaleString()}`;
    expect(progress).toHaveAttribute("data-slot", "progress");
    expect(progress).toHaveAttribute("aria-valuenow", String(expected));
    expect(progress).toHaveAttribute("aria-valuetext", amount);
    expect(progress).toHaveClass("h-2", "w-full", "bg-black/10");
    expect(progress.querySelector('[data-slot="progress-indicator"]')).toHaveStyle({ transform: `translateX(-${100 - expected}%)` });
    const label = screen.getByText("Credits used");
    expect(label.parentElement).toContainElement(screen.getByText(amount));
    expect(screen.getByText(amount)).toHaveClass("text-xs", "tabular-nums");
    expect(screen.queryByText(`${usedPercent}%`)).not.toBeInTheDocument();
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY])("does not expose an invalid progress value (%s)", async (usedPercent) => {
    render(<Fixture credit={{ state: "ready", label: "Credits used", used: 250, total: 1000, usedPercent }} />);
    await userEvent.click(screen.getByRole("button", { name: "Open user menu" }));
    const progress = screen.getByRole("progressbar", { name: "Credits used" });
    expect(progress).not.toHaveAttribute("aria-valuenow");
    expect(progress.querySelector('[data-slot="progress-indicator"]')).toHaveStyle({ transform: "translateX(-100%)" });
    expect(screen.queryByText(`${usedPercent}%`)).not.toBeInTheDocument();
  });

  it("initially focuses its visible heading, leaving sign-out inert on a second Enter", async () => {
    const signOut = vi.fn();
    const user = userEvent.setup();
    render(<Fixture onSignOut={signOut} />);
    await user.tab(); await user.keyboard("{Enter}");
    expect(await screen.findByRole("heading", { name: "Agent Owner" })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(signOut).not.toHaveBeenCalled();
    await user.tab();
    expect(screen.getByRole("link", { name: "Upgrade plan" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("link", { name: "My AI Companion" })).toHaveFocus();
  });

  it("opens by keyboard outside the clipped sidebar, exposes same-pass quota and returns focus on Escape", async () => {
    const user = userEvent.setup();
    render(<Fixture />);
    const trigger = screen.getByRole("button", { name: "Open user menu" });
    expect(trigger).toHaveTextContent("Agent Owner");
    expect(trigger).toHaveTextContent("Plan: Pro");
    await user.tab(); await user.keyboard("{Enter}");
    const dialog = await screen.findByRole("dialog", { name: "Account menu" });
    expect(screen.getByTestId("clipped-sidebar")).not.toContainElement(dialog);
    expect(dialog).toHaveClass("lv-sidebar-account-surface", "lv-sidebar-user-menu");
    expect(within(dialog).getByRole("progressbar", { name: "Credits used" })).toHaveAttribute("aria-valuenow", "25");
    expect(within(dialog).getByText("250 / 1,000")).toBeVisible();
    expect(within(dialog).getByRole("link", { name: "Upgrade plan" })).toHaveAttribute("href", "/subscribe/?upgrade_pass_id=p%2F1");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });

  it("keeps the parent open on the real nested language control's first Escape", async () => {
    const user = userEvent.setup();
    render(<Fixture languageContent={<InternationalLanguageMenu id="fixture-language" activeLocale="en-US" ariaLabel="Language options" reloadAfterSwitch />} />);
    const trigger = screen.getByRole("button", { name: "Open user menu" });
    await user.click(trigger);
    const language = screen.getByRole("button", { name: "Language" });
    language.focus(); await user.keyboard("{Enter}");
    const options = await screen.findByRole("group", { name: "Language options" });
    expect(within(options).getByRole("radio", { name: "English" })).toBeChecked();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("group", { name: "Language options" })).not.toBeInTheDocument());
    expect(screen.getByRole("dialog", { name: "Account menu" })).toBeVisible();
    expect(language).toHaveFocus();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it.each([false, true])("uses a viewport-fitting language placement (wide=%s) without changing Escape return", async (wide) => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: wide, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    const user = userEvent.setup();
    render(<Fixture languageContent={<InternationalLanguageMenu id="responsive-language" activeLocale="en-US" ariaLabel="Language options" reloadAfterSwitch />} />);
    await user.click(screen.getByRole("button", { name: "Open user menu" }));
    const trigger = screen.getByRole("button", { name: "Language" });
    await user.click(trigger);
    const language = screen.getByRole("dialog", { name: "Language" });
    // Real layout is checked by Root. This guards the intended collision axis,
    // allowing Radix to flip within that axis instead of forcing offscreen right.
    expect(wide ? ["right", "left"] : ["top", "bottom"]).toContain(language.getAttribute("data-side"));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(screen.getByRole("dialog", { name: "Account menu" })).toBeVisible();
  });

  it.each(["loading", "error", "none", "idle"] as const)("does not render a fabricated zero balance for %s", async (state) => {
    render(<Fixture credit={{ state, label: `State: ${state}` }} upgrade={undefined} />);
    await userEvent.click(screen.getByRole("button", { name: "Open user menu" }));
    expect(screen.getByText(`State: ${state}`)).toBeVisible();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Upgrade plan" })).not.toBeInTheDocument();
  });

  it("renders a genuinely loaded zero and submits sign-out intent once", async () => {
    const signOut = vi.fn();
    render(<Fixture credit={{ state: "ready", total: 0, used: 0, usedPercent: 0, label: "Credits used" }} onSignOut={signOut} />);
    await userEvent.click(screen.getByRole("button", { name: "Open user menu" }));
    expect(screen.getByText("0 / 0")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(signOut).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
});
