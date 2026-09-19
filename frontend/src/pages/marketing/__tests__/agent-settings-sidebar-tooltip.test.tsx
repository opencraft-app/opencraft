import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ConsoleTooltip } from "../agents-console/console-tooltip";

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Agent sidebar action tooltip", () => {
  it("portals outside the clipping sidebar and preserves keyboard and click actions", async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();
    const { container } = render(
      <TooltipProvider delayDuration={0}>
        <aside style={{ overflow: "hidden" }}>
          <ConsoleTooltip content="删除整个 Agent" side="bottom">
            <button type="button" onClick={onClick}>删除</button>
          </ConsoleTooltip>
        </aside>
      </TooltipProvider>,
    );
    const button = screen.getByRole("button", { name: "删除" });
    await user.hover(button);
    const tooltip = await screen.findByRole("tooltip");
    expect(container).not.toContainElement(tooltip);
    expect(tooltip.closest("[data-slot='tooltip-content']")).toHaveAttribute("data-side", "bottom");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    await user.unhover(button);
    await user.tab();
    expect(await screen.findByRole("tooltip")).toHaveTextContent("删除整个 Agent");
    await user.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });
});
