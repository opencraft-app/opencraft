import { useRef, useState } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Button } from "../button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../dropdown-menu";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogTitle, AlertDialogTrigger } from "../alert-dialog";
import { Checkbox } from "../checkbox";
import { Switch } from "../switch";
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from "../sheet";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../tooltip";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../dialog";

afterEach(cleanup);
beforeAll(() => {
  // jsdom has no layout observer; Radix uses it to measure its tooltip arrow.
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
});
afterAll(() => vi.unstubAllGlobals());

describe("Agents Radix primitives", () => {
  it("navigates a portalled menu with the keyboard, skips disabled actions, and restores focus on Escape", async () => {
    const selected = vi.fn();
    const user = userEvent.setup();
    const view = render(
      <DropdownMenu>
        <DropdownMenuTrigger asChild><Button>Actions</Button></DropdownMenuTrigger>
        <DropdownMenuContent portalClassName="consumer-scope">
          <DropdownMenuItem onSelect={selected}>Rename</DropdownMenuItem>
          <DropdownMenuItem disabled onSelect={selected}>Delete</DropdownMenuItem>
          <DropdownMenuItem onSelect={selected}>Export</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    await user.tab();
    await user.keyboard("{ArrowDown}");
    expect(await screen.findByRole("menu")).toHaveClass("consumer-scope");
    expect(view.container).not.toContainElement(screen.getByRole("menu"));
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "Rename" })).toHaveFocus());
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Export" })).toHaveFocus();
    expect(screen.getByRole("menuitem", { name: "Delete" })).toHaveAttribute("aria-disabled", "true");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.getByRole("button", { name: "Actions" })).toHaveFocus());
    expect(selected).not.toHaveBeenCalled();
    await user.keyboard("{ArrowDown}");
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "Rename" })).toHaveFocus());
    await user.keyboard("{Enter}");
    expect(selected).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
  });

  it("leaves an async confirmation open until its host resolves and closes it", async () => {
    const user = userEvent.setup();
    let complete: () => void = () => undefined;
    const request = new Promise<void>((resolve) => { complete = resolve; });
    const confirm = vi.fn(() => request);
    function Confirmation() {
      const [open, setOpen] = useState(false);
      const [pending, setPending] = useState(false);
      return (
        <AlertDialog open={open} onOpenChange={(next) => { if (!pending) setOpen(next); }}>
          <AlertDialogTrigger asChild><Button>Remove item</Button></AlertDialogTrigger>
          <AlertDialogContent portalClassName="consumer-scope" onEscapeKeyDown={(event) => { if (pending) event.preventDefault(); }}>
            <AlertDialogTitle>Remove this item?</AlertDialogTitle>
            <AlertDialogDescription>This operation removes the item.</AlertDialogDescription>
            <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={pending} onClick={(event) => {
              event.preventDefault();
              setPending(true);
              void confirm().then(() => { setPending(false); setOpen(false); });
            }}>Confirm</AlertDialogAction>
          </AlertDialogContent>
        </AlertDialog>
      );
    }
    render(<Confirmation />);
    await user.click(screen.getByRole("button", { name: "Remove item" }));
    expect(screen.getByRole("alertdialog")).toHaveAccessibleDescription("This operation removes the item.");
    expect(screen.getByRole("alertdialog")).toHaveClass("consumer-scope");
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Confirm" })).toBeDisabled();
    await user.keyboard("{Escape}");
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    await act(async () => { complete(); await request; });
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Remove item" })).toHaveFocus();
  });

  it("preserves controlled switch values until the host updates them", async () => {
    const changed = vi.fn();
    const user = userEvent.setup();
    const view = render(<Switch aria-label="Enabled" checked={false} onCheckedChange={changed} />);
    await user.tab();
    await user.keyboard(" ");
    expect(changed).toHaveBeenCalledWith(true);
    expect(screen.getByRole("switch")).not.toBeChecked();
    view.rerender(<Switch aria-label="Enabled" checked onCheckedChange={changed} />);
    expect(screen.getByRole("switch")).toBeChecked();
    view.rerender(<Switch aria-label="Enabled" checked disabled onCheckedChange={changed} />);
    await user.click(screen.getByRole("switch"));
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("supports controlled mixed checkboxes and prevents disabled changes", async () => {
    const changed = vi.fn();
    const user = userEvent.setup();
    const view = render(<Checkbox aria-label="Select all" checked="indeterminate" onCheckedChange={changed} />);
    expect(screen.getByRole("checkbox")).toBePartiallyChecked();
    await user.tab();
    await user.keyboard(" ");
    expect(changed).toHaveBeenCalledWith(true);
    expect(screen.getByRole("checkbox")).toBePartiallyChecked();
    view.rerender(<Checkbox aria-label="Select all" checked disabled onCheckedChange={changed} />);
    await user.click(screen.getByRole("checkbox"));
    expect(changed).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("checkbox")).toBeChecked();
  });

  it("keeps sheet navigation modal and restores its trigger on Escape", async () => {
    const user = userEvent.setup();
    const view = render(
      <Sheet>
        <SheetTrigger asChild><Button>Navigation</Button></SheetTrigger>
        <SheetContent side="left" closeLabel="Close navigation" portalClassName="consumer-scope">
          <SheetTitle>Agent navigation</SheetTitle>
          <SheetDescription>Choose a section.</SheetDescription>
          <a href="#models">Models</a>
        </SheetContent>
      </Sheet>,
    );
    await user.click(screen.getByRole("button", { name: "Navigation" }));
    const sheet = screen.getByRole("dialog", { name: "Agent navigation" });
    expect(sheet).toHaveClass("consumer-scope");
    expect(view.container).not.toContainElement(sheet);
    // Radix excludes links from initial auto-focus; tabbing still reaches them.
    expect(screen.getByRole("button", { name: "Close navigation" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("link", { name: "Models" })).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByRole("button", { name: "Close navigation" })).toHaveFocus();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.getByRole("button", { name: "Navigation" })).toHaveFocus());
  });

  it("exposes a tooltip on focus outside a clipping container and dismisses it with Escape", async () => {
    const user = userEvent.setup();
    const view = render(
      <div style={{ overflow: "hidden" }}>
        <TooltipProvider delayDuration={0}>
          <Tooltip>
            <TooltipTrigger asChild><button type="button">Help</button></TooltipTrigger>
            <TooltipContent portalClassName="consumer-scope">Copy this explanation</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>,
    );
    await user.tab();
    const tooltip = await screen.findByRole("tooltip");
    expect(view.container).not.toContainElement(tooltip);
    const surface = tooltip.closest("[data-slot='tooltip-content']");
    expect(surface).toHaveClass("consumer-scope", "select-text", "pointer-events-auto");
    expect(screen.getByRole("button", { name: "Help" })).toHaveAccessibleDescription("Copy this explanation");
    if (!(surface instanceof HTMLElement)) throw new Error("Tooltip surface is missing");
    await user.hover(surface);
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    // Starting a text selection blurs the focused trigger to the document body.
    // The pointer event must remain uncancelled so native selection can proceed.
    let pointerDownPrevented = false;
    surface.addEventListener("pointerdown", (event) => {
      queueMicrotask(() => { pointerDownPrevented = event.defaultPrevented; });
    });
    await user.pointer({ target: surface, keys: "[MouseLeft>]" });
    expect(screen.getByRole("button", { name: "Help" })).not.toHaveFocus();
    expect(pointerDownPrevented).toBe(false);
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    const range = document.createRange();
    range.selectNodeContents(surface);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    expect(window.getSelection()?.toString()).toContain("Copy this explanation");
    await user.pointer({ target: surface, keys: "[/MouseLeft]" });
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("allows a menu action to hand focus to a controlled dialog", async () => {
    const user = userEvent.setup();
    function MenuDialog() {
      const [open, setOpen] = useState(false);
      const trigger = useRef<HTMLButtonElement>(null);
      return <>
        <DropdownMenu>
          <DropdownMenuTrigger asChild><Button ref={trigger}>More</Button></DropdownMenuTrigger>
          <DropdownMenuContent onCloseAutoFocus={(event) => { if (open) event.preventDefault(); }}>
            <DropdownMenuItem onSelect={() => setOpen(true)}>Edit name</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent onCloseAutoFocus={(event) => { event.preventDefault(); trigger.current?.focus(); }}>
            <DialogTitle>Edit name</DialogTitle>
            <DialogDescription>Enter a new name.</DialogDescription>
            <input aria-label="Name" />
          </DialogContent>
        </Dialog>
      </>;
    }
    render(<MenuDialog />);
    await user.tab();
    await user.keyboard("{ArrowDown}");
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "Edit name" })).toHaveFocus());
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Name" })).toHaveFocus());
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.getByRole("button", { name: "More" })).toHaveFocus());
  });

  it("clears selection tracking when Escape unmounts content before pointer release", async () => {
    const user = userEvent.setup();
    render(<TooltipProvider delayDuration={0}><Tooltip><TooltipTrigger asChild><button>Help</button></TooltipTrigger><TooltipContent>Explanation</TooltipContent></Tooltip><button>Next</button></TooltipProvider>);
    await user.hover(screen.getByRole("button", { name: "Help" }));
    const surface = (await screen.findByRole("tooltip")).closest("[data-slot='tooltip-content']");
    if (!(surface instanceof HTMLElement)) throw new Error("Tooltip surface is missing");
    await user.pointer({ target: surface, keys: "[MouseLeft>]" });
    await user.keyboard("{Escape}");
    await user.pointer({ target: document.body, keys: "[/MouseLeft]" });
    await user.tab();
    expect(screen.getByRole("button", { name: "Help" })).toHaveFocus();
    expect(await screen.findByRole("tooltip")).toBeInTheDocument();
    await user.tab();
    expect(screen.getByRole("button", { name: "Next" })).toHaveFocus();
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });
});
