import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentField, AgentSection, AgentState, AgentToolbar } from "../index";

afterEach(cleanup);

describe("Agents presentation contract", () => {
  it("renders caller-owned headings, actions and content without a provider", async () => {
    const save = vi.fn();
    render(
      <AgentSection title="Models" description="Available providers" actions={<button onClick={save}>Save</button>}>
        <AgentToolbar label="Model filters"><input aria-label="Search models" /></AgentToolbar>
        <p>Current model</p>
      </AgentSection>,
    );
    expect(screen.getByRole("region", { name: "Models" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Models" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Model filters" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("connects labels, help and validation to an explicitly controlled input", async () => {
    const changed = vi.fn();
    render(
      <AgentField label="Model name" description="Use the provider model ID" error="Required field" required>
        {(field) => <input {...field} value="" onChange={(event) => changed(event.target.value)} />}
      </AgentField>,
    );
    const input = screen.getByRole("textbox", { name: "Model name" });
    expect(input).toHaveAccessibleDescription("Use the provider model ID Required field");
    expect(input).toBeInvalid();
    expect(input).toBeRequired();
    await userEvent.type(input, "x");
    expect(changed).toHaveBeenCalledWith("x");
    expect(input).toHaveValue("");
  });

  it.each(["loading", "empty", "error", "success"] as const)("expresses the %s state and preserves its explicit action", (kind) => {
    render(<AgentState kind={kind} title={`${kind} title`} description="Details" action={<button>Next action</button>} />);
    const state = screen.getByRole(kind === "error" ? "alert" : "status");
    expect(state).toHaveTextContent(`${kind} title`);
    expect(state).toHaveAttribute("aria-busy", kind === "loading" ? "true" : "false");
    expect(screen.getByRole("button", { name: "Next action" })).toBeEnabled();
  });
});
