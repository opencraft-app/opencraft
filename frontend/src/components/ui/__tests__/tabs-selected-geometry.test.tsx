import { readFileSync } from "node:fs";
import { join } from "node:path";
import { useState } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compile } from "tailwindcss";
import { Tabs, TabsList, TabsTrigger } from "../tabs";

afterEach(cleanup);

describe("segmented selected geometry", () => {
  it.each([
    ["Memory", "h-auto max-w-full flex-wrap rounded-md p-1"],
    ["Packages", "h-auto max-w-full justify-start overflow-x-auto rounded-md p-1"],
  ])("preserves intrinsic vertical padding for %s auto-height tabs", async (label, className) => {
    render(<Tabs defaultValue="first"><TabsList aria-label={label} className={className}>
      <TabsTrigger value="first">First</TabsTrigger><TabsTrigger value="second">Second</TabsTrigger>
    </TabsList></Tabs>);
    const triggers = screen.getAllByRole("tab");
    // Browser comparison: h-auto resolves h-full intrinsically. Without py-2,
    // the former 36px target shrinks to its 20px line height (list 46px -> 30px).
    for (const trigger of triggers) {
      expect(trigger).toHaveClass("h-full", "min-h-0", "py-2");
      expect(trigger).not.toHaveClass("py-0");
    }
    const first = screen.getByRole("tab", { name: "First" });
    const generated = (await compile("@theme { --spacing: 0.25rem; } @tailwind utilities;")).build(first.className.split(" "));
    expect(generated).toContain("height: 100%;");
    expect(generated).toContain("padding-block: calc(var(--spacing) * 2);");
    await userEvent.tab();
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Second" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Second" })).toHaveFocus();
  });

  it.each(["h-9", "h-10"])("keeps %s triggers inside the list's padded inner height while retaining keyboard selection", async (heightClass) => {
    const changed = vi.fn();
    function Fixture() {
      const [value, setValue] = useState("current");
      return <Tabs value={value} onValueChange={(next) => { changed(next); setValue(next); }}><TabsList aria-label="Task views" className={heightClass}>
        <TabsTrigger value="current">Current</TabsTrigger><TabsTrigger value="ended">Ended</TabsTrigger>
      </TabsList></Tabs>;
    }
    render(<Fixture />);
    expect(screen.getByRole("tablist")).toHaveClass("p-1", "border", heightClass);
    // jsdom does not perform layout. The real 36/40px browser regression is
    // covered by enforcing the inner-height contract, not fake measurements.
    for (const tab of screen.getAllByRole("tab")) {
      expect(tab).toHaveClass("h-full", "min-h-0", "py-2");
    }
    const user = userEvent.setup();
    await user.tab();
    await user.keyboard("{ArrowRight}");
    await waitFor(() => expect(screen.getByRole("tab", { name: "Ended" })).toHaveAttribute("aria-selected", "true"));
    expect(changed).toHaveBeenCalledExactlyOnceWith("ended");
    expect(screen.getByRole("tab", { name: "Ended" })).toHaveFocus();
  });

  it("feeds the winning Tailwind background utilities an Agents-local white track with grey selected tabs", async () => {
    const styles = readFileSync(join(process.cwd(), "src/styles.css"), "utf8");
    const rule = styles.match(/\.agents-ui \[role="tablist"\]\s*\{([^}]*)\}/s)?.[1];
    const declaration = document.createElement("div").style;
    declaration.cssText = rule ?? "";
    expect(declaration.getPropertyValue("--surface-muted")).toBe("#fff");
    render(<><Tabs><TabsList aria-label="Automation tabs" className="h-9" /></Tabs><Tabs><TabsList aria-label="Sidebar tabs" className="h-10 bg-[var(--surface-muted)]" /></Tabs></>);
    const backgrounds = screen.getAllByRole("tablist").flatMap((list) => list.className.split(" ").filter((name) => name.startsWith("bg-")));
    expect(backgrounds).toEqual(["bg-[color-mix(in_oklab,var(--surface-muted)_84%,white)]", "bg-[var(--surface-muted)]"]);
    const generated = (await compile("@tailwind utilities;")).build(backgrounds);
    // Compile the actual winning classes: both consume the locally scoped
    // token even when the utilities layer outranks app-layer backgrounds.
    expect(generated).toContain("background-color: var(--surface-muted);");
    expect(generated).toContain("background-color: color-mix(in oklab,var(--surface-muted) 84%,white);");
    expect(generated).not.toMatch(/--surface-muted\s*:/);
    expect(styles).toMatch(/\.agents-ui \[role="tab"\]\[data-state="active"\]\s*\{[^}]*background:\s*#dedede !important;[^}]*color:\s*#171717 !important;/s);
  });

  it("keeps the scoped desktop header surface authoritative over its existing inline background", async () => {
    const styles = readFileSync(join(process.cwd(), "src/styles.css"), "utf8");
    const rule = styles.match(/header\.lv-agent-sidebar-header\s*\{([^}]*)\}/s)?.[1];
    // jsdom drops var() in background shorthand. Use the production CSS
    // compiler to verify priority is retained, without claiming layout.
    const generated = (await compile(`@layer app { header.lv-agent-sidebar-header { ${rule ?? ""} } }`)).build([]);
    expect(generated).toContain("header.lv-agent-sidebar-header {");
    expect(generated).toContain("background: #fff !important;");
  });
});
