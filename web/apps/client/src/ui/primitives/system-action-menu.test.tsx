/** @jest-environment jsdom */

import {fireEvent, render, screen, waitFor} from "@testing-library/react";
import {existsSync} from "node:fs";
import {join} from "node:path";
import {useState} from "react";

const sharedPath = join(__dirname, "system-action-menu.tsx");
const typesPath = join(__dirname, "system-action-menu.types.ts");
const webPath = join(__dirname, "system-action-menu.web.tsx");
const nativePath = join(__dirname, "system-action-menu.native.tsx");

describe("SystemActionMenu", () => {
  beforeAll(() => {
    Object.defineProperty(globalThis, "CSS", {
      configurable: true,
      value: {escape: (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "\\$&")},
    });
  });

  it("provides one controlled contract with Web and Native adapters", () => {
    expect([sharedPath, typesPath, webPath, nativePath].every(existsSync)).toBe(true);
    const ui = require("../index") as Record<string, unknown>;
    expect(ui.SystemActionMenu).toBeDefined();
  });

  it("runs one enabled action, closes with an action reason and restores focus", async () => {
    const {SystemActionMenu} = require(
      "./system-action-menu.web"
    ) as typeof import("./system-action-menu.web");
    const onAction = jest.fn();
    const changes: Array<[boolean, string | undefined]> = [];

    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <SystemActionMenu
          accessibilityLabel="账号操作"
          items={[
            {id: "logout", intent: "destructive", label: "退出当前账号"},
          ]}
          onAction={onAction}
          onOpenChange={(next, reason) => {
            changes.push([next, reason]);
            setOpen(next);
          }}
          open={open}
          overlayId="account-action-menu"
          renderTrigger={({accessibilityControls, accessibilityExpanded, onPress, ref}) => (
            <button
              aria-controls={accessibilityControls}
              aria-expanded={accessibilityExpanded}
              aria-haspopup="menu"
              onClick={onPress}
              ref={ref as React.Ref<HTMLButtonElement>}
              type="button"
            >
              打开账号菜单
            </button>
          )}
        />
      );
    }

    render(<Harness />);
    const trigger = screen.getByRole("button", {name: "打开账号菜单"});
    fireEvent.click(trigger);

    expect(screen.getByRole("menu", {name: "账号操作"})).not.toBeNull();
    expect(screen.queryByRole("menuitem", {name: "Jindong Zhang"})).toBeNull();
    expect(screen.getByRole("menu", {name: "账号操作"}).getAttribute("style"))
      .toContain("display: flex; flex-direction: column");
    fireEvent.click(screen.getByRole("menuitem", {name: "退出当前账号"}));

    expect(onAction).toHaveBeenCalledWith("logout");
    expect(changes).toContainEqual([false, "action"]);
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });
});
