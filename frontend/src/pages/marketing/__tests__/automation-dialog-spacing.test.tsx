import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AutomationDialogView } from "../automation-dialog-view";

afterEach(cleanup);

describe("AutomationDialogView spacing", () => {
  it("owns the spacing below its header", () => {
    render(<AutomationDialogView title="Task" closeLabel="Close" onClose={vi.fn()}><div>First block</div></AutomationDialogView>);
    expect(screen.getByRole("heading", { name: "Task" }).parentElement).toHaveClass("mb-5");
  });

  it("does not make automation consumers repeat first-block top margins", () => {
    const source = readFileSync(join(process.cwd(), "src/pages/marketing/agent-automations-panel.tsx"), "utf8");
    expect(source).not.toMatch(/<dl className="mt-[45] overflow-hidden/);
    expect(source).not.toContain('<fieldset className="mt-4">');
    expect(source).not.toContain('canSelectZeroToken || executionMode === "zero_token" ? "mt-3" : "mt-4"');
  });
});
