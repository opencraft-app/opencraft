/** @jest-environment jsdom */

import {fireEvent, render, screen, waitFor} from "@testing-library/react";
import {existsSync} from "node:fs";
import {join} from "node:path";
import {useState} from "react";

const sharedPath = join(__dirname, "system-popover.tsx");
const webPath = join(__dirname, "system-popover.web.tsx");
const nativePath = join(__dirname, "system-popover.native.tsx");

describe("SystemPopover", () => {
  it("provides one controlled contract with Web and Native adapters", () => {
    expect([sharedPath, webPath, nativePath].every(existsSync)).toBe(true);
    const ui = require("../index") as Record<string, unknown>;
    expect(ui.SystemPopover).toBeDefined();
  });

  it("closes with Escape and restores focus to its trigger", async () => {
    if (!existsSync(webPath)) return;
    const {SystemPopover} = require(
      "./system-popover.web"
    ) as typeof import("./system-popover.web");
    const changes: Array<[boolean, string | undefined]> = [];

    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <SystemPopover
          accessibilityLabel="当前账号"
          onOpenChange={(next, reason) => {
            changes.push([next, reason]);
            setOpen(next);
          }}
          open={open}
          overlayId="account-popover"
          placement="right bottom"
          renderTrigger={({accessibilityControls, accessibilityExpanded, onPress, ref}) => (
            <button
              aria-controls={accessibilityControls}
              aria-expanded={accessibilityExpanded}
              aria-haspopup="dialog"
              onClick={onPress}
              ref={ref as React.Ref<HTMLButtonElement>}
              type="button"
            >
              打开账号
            </button>
          )}
          width={280}
        >
          <button type="button">退出账号</button>
        </SystemPopover>
      );
    }

    render(<Harness />);
    const trigger = screen.getByRole("button", {name: "打开账号"});
    fireEvent.click(trigger);

    const popover = screen.getByRole("dialog", {name: "当前账号"});
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(popover).not.toBeNull();
    expect(popover.getAttribute("style")).toContain("width: 280px");
    fireEvent.keyDown(screen.getByRole("button", {name: "退出账号"}), {
      key: "Escape",
    });

    expect(changes).toContainEqual([false, "escape"]);
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("restores focus when content closes the controlled overlay", async () => {
    const {SystemPopover} = require(
      "./system-popover.web"
    ) as typeof import("./system-popover.web");

    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <SystemPopover
          accessibilityLabel="日期选择"
          onOpenChange={setOpen}
          open={open}
          overlayId="date-popover"
          renderTrigger={({accessibilityControls, accessibilityExpanded, onPress, ref}) => (
            <button
              aria-controls={accessibilityControls}
              aria-expanded={accessibilityExpanded}
              onClick={onPress}
              ref={ref as React.Ref<HTMLButtonElement>}
              type="button"
            >
              选择日期
            </button>
          )}
        >
          <button onClick={() => setOpen(false)} type="button">确认日期</button>
        </SystemPopover>
      );
    }

    render(<Harness />);
    const trigger = screen.getByRole("button", {name: "选择日期"});
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", {name: "确认日期"}));

    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });
});
