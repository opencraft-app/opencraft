import * as React from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as agentComponents from "@/components/agents";
import { Tabs } from "@/components/ui/tabs";

afterEach(cleanup);

type TabVariant = "segmented" | "underline";
type AgentTabsPartProps = React.PropsWithChildren<{
  value?: string;
  variant: TabVariant;
  disabled?: boolean;
  "aria-label"?: string;
}>;

function getAgentTabsParts() {
  const exports = agentComponents as Record<string, unknown>;
  expect(exports.AgentTabsList).toBeDefined();
  expect(exports.AgentTabsTrigger).toBeDefined();
  return {
    List: exports.AgentTabsList as React.ElementType<AgentTabsPartProps>,
    Trigger: exports.AgentTabsTrigger as React.ElementType<AgentTabsPartProps>,
  };
}

describe("Agent Tabs variants", () => {
  it.each([
    ["segmented", "bg-[var(--agent-tabs-track,#f3f3f1)]", "data-[state=active]:bg-[var(--agent-tabs-selected,#fff)]"],
    ["underline", "bg-transparent", "data-[state=active]:after:bg-[var(--text-primary)]"],
  ] as const)("keeps the %s palette opt-in", (variant, listClass, triggerClass) => {
    const { List, Trigger } = getAgentTabsParts();
    render(<Tabs defaultValue="first"><List variant={variant} aria-label={`${variant} tabs`}><Trigger variant={variant} value="first">First</Trigger><Trigger variant={variant} value="second">Second</Trigger></List></Tabs>);
    expect(screen.getByRole("tablist")).toHaveClass(listClass);
    expect(screen.getByRole("tab", { name: "First" })).toHaveClass(triggerClass);
  });

  it("retains Radix keyboard selection and disabled behavior", async () => {
    const { List, Trigger } = getAgentTabsParts();
    const changed = vi.fn();
    function Fixture() {
      const [value, setValue] = React.useState("first");
      return <Tabs value={value} onValueChange={(next) => { changed(next); setValue(next); }}><List variant="segmented" aria-label="Views"><Trigger variant="segmented" value="first">First</Trigger><Trigger variant="segmented" value="blocked" disabled>Blocked</Trigger><Trigger variant="segmented" value="second">Second</Trigger></List></Tabs>;
    }
    render(<Fixture />);
    const user = userEvent.setup();
    await user.tab();
    await user.keyboard("{ArrowRight}");
    await waitFor(() => expect(screen.getByRole("tab", { name: "Second" })).toHaveAttribute("aria-selected", "true"));
    expect(screen.getByRole("tab", { name: "Blocked" })).toBeDisabled();
    expect(changed).toHaveBeenCalledExactlyOnceWith("second");
  });

  it("does not expose a tab choice variant for radio selections", () => {
    const source = readFileSync(join(process.cwd(), "src/components/agents/agent-tabs.tsx"), "utf8");
    expect(source).not.toContain('"choice"');
  });

  it("lets the automation underline list use its intrinsic trigger height", () => {
    const source = readFileSync(join(process.cwd(), "src/pages/marketing/agent-automations-panel.tsx"), "utf8");
    expect(source).toContain('<AgentTabsList variant="underline" aria-label={t("定时任务")} className="h-auto">');
    expect(source).toContain('<AgentTabsList variant="segmented" aria-label={t("执行时间")} className="h-9">');
  });
});
