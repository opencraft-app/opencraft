import { useState } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AgentConfirmDialog, AgentTooltip } from "../index";
beforeAll(() => vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} }));
afterAll(() => vi.unstubAllGlobals());
afterEach(cleanup);
describe("Agent interaction adapters", () => {
  it("keeps enabled controls to one tab stop and makes disabled explanations focusable", async () => {
    const user = userEvent.setup();
    render(<><AgentTooltip content="Enabled help" triggerMode="control"><button>Enabled</button></AgentTooltip>
      <AgentTooltip content="Disabled reason"><button disabled>Disabled</button></AgentTooltip><button>Next</button></>);
    await user.tab(); expect(screen.getByRole("button", { name: "Enabled" })).toHaveFocus();
    await user.tab(); expect(screen.getByRole("group", { name: "Disabled reason" })).toHaveFocus();
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Disabled reason");
    await user.tab(); expect(screen.getByRole("button", { name: "Next" })).toHaveFocus();
  });
  it("supports block descriptions without nested paragraphs and leaves close timing to its host", async () => {
    const confirm = vi.fn();
    function Fixture() {
      const [open, setOpen] = useState(false);
      return <><button onClick={() => setOpen(true)}>Open</button><AgentConfirmDialog open={open} onOpenChange={setOpen}
        title="Change settings" description={<><p>First paragraph.</p><ul><li>Second detail.</li></ul></>}
        cancelLabel="Cancel" confirmLabel="Confirm" confirmVariant="default" onConfirm={confirm} /></>;
    }
    const user = userEvent.setup();
    render(<Fixture />);
    await user.click(screen.getByRole("button", { name: "Open" }));
    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toHaveAccessibleDescription("First paragraph. Second detail.");
    const description = document.getElementById(dialog.getAttribute("aria-describedby")!);
    expect(description?.tagName).toBe("DIV");
    expect(description?.querySelector("p p")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(dialog).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.getByRole("button", { name: "Open" })).toHaveFocus());
  });
});
