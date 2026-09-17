import { useRef, useState } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppNavigationProvider, type AppNavigationValue } from "@/lib/app-navigation";
import { ConsoleConfirmDialog, ConsoleSessionList } from "../index";

const navigation: AppNavigationValue = {
  Link: ({ to, children, ...props }) => <a href={to} {...props}>{children}</a>,
  pathname: "/agents/chat", search: "", navigate: () => undefined, setSearchParams: () => undefined,
};
const labels = { navigation: "Sessions", recent: "Recent", loading: "Loading", defaultChat: "Default chat", actions: "Actions", rename: "Rename", delete: "Delete", name: "Name", cancel: "Cancel", confirm: "Confirm", protectedSession: "Default cannot be deleted" };

beforeEach(() => { vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("controlled session presentation", () => {
  it("preserves the empty default id, keyboard rename, cancel, and focus across menu/dialog", async () => {
    const rename = vi.fn();
    const remove = vi.fn();
    function Sessions() {
      const [menuId, setMenuId] = useState<string | null>(null);
      const [renameId, setRenameId] = useState<string | null>(null);
      const [draft, setDraft] = useState("");
      const [deleting, setDeleting] = useState<string | null>(null);
      const actionTriggerRef = useRef<HTMLElement | null>(null);
      return <AppNavigationProvider value={navigation}>
        <ConsoleSessionList sessions={[{ id: "", title: "Default", canDelete: false }, { id: "second", title: "Second", canDelete: true }]} loading={false} selectedId="" href="/agents/chat" active actionsAvailable menuId={menuId} renameId={renameId} renameDraft={draft} confirmationOpen={deleting !== null} actionTriggerRef={actionTriggerRef}
          onMenuChange={setMenuId} onSelect={() => undefined} onNavigate={() => undefined}
          onRename={(id) => { setMenuId(null); setRenameId(id); setDraft("Default"); }} onDelete={(id) => { setMenuId(null); setDeleting(id); }}
          onRenameDraftChange={setDraft} onRenameCommit={() => { rename(renameId, draft); setRenameId(null); }} onRenameCancel={() => setRenameId(null)} labels={labels} />
        <ConsoleConfirmDialog open={deleting !== null} onOpenChange={(open) => { if (!open) setDeleting(null); }} title="Delete session" description="Cannot undo" confirmLabel="Confirm delete" cancelLabel="Cancel" returnFocusRef={actionTriggerRef} onConfirm={() => { remove(deleting); setDeleting(null); }} />
      </AppNavigationProvider>;
    }
    const user = userEvent.setup();
    render(<Sessions />);
    const selectedLink = screen.getByRole("link", { name: "Default" });
    expect(selectedLink).toHaveAttribute("aria-current", "page");
    expect(selectedLink.closest("li")).toHaveClass("is-active");
    expect(selectedLink.closest("li")).toContainElement(screen.getAllByRole("button", { name: "Actions" })[0]!);
    const trigger = screen.getAllByRole("button", { name: "Actions" })[0]!;
    await user.click(trigger);
    expect(screen.getByRole("menuitem", { name: "Delete" })).toHaveAttribute("data-disabled");
    expect(screen.getByText("Default cannot be deleted")).toBeVisible();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(trigger).toHaveFocus());
    await user.keyboard("{Enter}");
    await user.keyboard("{Enter}");
    const input = await screen.findByRole("textbox", { name: "Name" });
    expect(input).toHaveFocus();
    await user.clear(input);
    await user.type(input, "Renamed default{Enter}");
    expect(rename).toHaveBeenCalledExactlyOnceWith("", "Renamed default");
    await waitFor(() => expect(trigger).toHaveFocus());
    await user.keyboard("{Enter}{Enter}");
    expect(await screen.findByRole("dialog", { name: "Rename" })).toBeVisible();
    await user.keyboard("{Escape}");
    expect(rename).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(trigger).toHaveFocus());
    const secondTrigger = screen.getAllByRole("button", { name: "Actions" })[1]!;
    await user.click(secondTrigger);
    await user.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(await screen.findByRole("alertdialog", { name: "Delete session" })).toBeVisible();
    await user.keyboard("{Escape}");
    expect(remove).not.toHaveBeenCalled();
    await waitFor(() => expect(secondTrigger).toHaveFocus());
  });

  it("keeps a navigation entry for an empty session list without requiring SDK actions", () => {
    render(<AppNavigationProvider value={navigation}><ConsoleSessionList sessions={[]} loading={false} href="/agents/chat?bot=main" active actionsAvailable={false} menuId={null} renameId={null} renameDraft="" confirmationOpen={false} actionTriggerRef={{ current: null }} onMenuChange={() => undefined} onSelect={() => undefined} onRename={() => undefined} onDelete={() => undefined} onRenameDraftChange={() => undefined} onRenameCommit={() => undefined} onRenameCancel={() => undefined} onNavigate={() => undefined} labels={labels} /></AppNavigationProvider>);
    expect(screen.getByRole("link", { name: "Default chat" })).toHaveAttribute("href", "/agents/chat?bot=main");
    expect(screen.queryByRole("button", { name: "Actions" })).not.toBeInTheDocument();
  });
});
