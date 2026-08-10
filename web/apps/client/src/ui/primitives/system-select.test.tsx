/** @jest-environment jsdom */

import {fireEvent, render, screen, waitFor} from "@testing-library/react";
import {existsSync} from "node:fs";
import {join} from "node:path";
import {useState} from "react";

jest.mock("lucide-react-native/icons/check", () => () => null);

const sharedPath = join(__dirname, "system-select.tsx");
const webPath = join(__dirname, "system-select.web.tsx");
const nativePath = join(__dirname, "system-select.native.tsx");

describe("SystemSelect", () => {
  beforeAll(() => {
    Object.defineProperty(globalThis, "CSS", {
      configurable: true,
      value: {escape: (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "\\$&")},
    });
  });

  it("provides a controlled Web implementation and a Native boundary", () => {
    expect([sharedPath, webPath, nativePath].every(existsSync)).toBe(true);
    const ui = require("../index") as Record<string, unknown>;
    expect(ui.SystemSelect).toBeDefined();
    expect(ui.SystemSelectField).toBeDefined();
  });

  it("provides a field-height trigger without leaking overlay state to forms", () => {
    const {SystemSelectField} = require(
      "./system-select-field.web"
    ) as typeof import("./system-select-field.web");
    render(
      <SystemSelectField
        accessibilityLabel="执行 Agent"
        onChange={jest.fn()}
        options={[{label: "研究助手", value: "agent-1"}]}
        overlayId="field-agent-listbox"
        value="agent-1"
      />,
    );

    const trigger = screen.getByRole("combobox", {name: "执行 Agent"});
    expect(trigger.textContent).toContain("研究助手");
    expect(trigger.style.height).not.toBe("");
    fireEvent.click(trigger);
    expect(screen.getByRole("listbox", {name: "执行 Agent"})).not.toBeNull();
  });

  it("opens a listbox, selects one resource and restores trigger focus", async () => {
    if (!existsSync(webPath)) return;
    const {SystemSelect} = require("./system-select.web") as typeof import("./system-select.web");
    const onChange = jest.fn();
    const changes: Array<[boolean, string | undefined]> = [];

    function Harness() {
      const [open, setOpen] = useState(false);
      const [value, setValue] = useState<string | null>("agent-1");
      return (
        <SystemSelect
          accessibilityLabel="执行 Agent"
          onChange={next => {
            setValue(next);
            onChange(next);
          }}
          onOpenChange={(next, reason) => {
            changes.push([next, reason]);
            setOpen(next);
          }}
          open={open}
          options={[
            {label: "研究助手", value: "agent-1"},
            {label: "发布助手", value: "agent-2"},
          ]}
          overlayId="agent-select-listbox"
          renderTrigger={({accessibilityControls, accessibilityExpanded, onPress, ref}) => (
            <button
              aria-controls={accessibilityControls}
              aria-expanded={accessibilityExpanded}
              aria-haspopup="listbox"
              onClick={onPress}
              ref={ref as React.Ref<HTMLButtonElement>}
              type="button"
            >
              选择 Agent
            </button>
          )}
          value={value}
        />
      );
    }

    render(<Harness />);
    const trigger = screen.getByRole("button", {name: "选择 Agent"});
    fireEvent.click(trigger);

    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("listbox", {name: "执行 Agent"})).not.toBeNull();
    expect(
      screen.getByRole("option", {name: "研究助手"}).getAttribute("aria-selected"),
    ).toBe("true");

    fireEvent.click(screen.getByRole("option", {name: "发布助手"}));
    expect(onChange).toHaveBeenCalledWith("agent-2");
    expect(changes).toContainEqual([false, "selection"]);
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });
});
