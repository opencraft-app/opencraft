/** @jest-environment jsdom */

import {fireEvent, render, screen, waitFor} from "@testing-library/react";
import {existsSync} from "node:fs";
import {join} from "node:path";
import {useState} from "react";

const sharedPath = join(__dirname, "system-dialog.tsx");
const typesPath = join(__dirname, "system-dialog.types.ts");
const webPath = join(__dirname, "system-dialog.web.tsx");
const nativePath = join(__dirname, "system-dialog.native.tsx");

describe("SystemDialog", () => {
  it("provides one controlled contract with Web and Native adapters", () => {
    expect([sharedPath, typesPath, webPath, nativePath].every(existsSync)).toBe(true);
    const ui = require("../index") as Record<string, unknown>;
    expect(ui.SystemDialog).toBeDefined();
  });

  it("keeps dangerous confirmation out of initial focus and reports cancel", async () => {
    const {SystemDialog} = require(
      "./system-dialog.web"
    ) as typeof import("./system-dialog.web");
    const actions: string[] = [];
    const closes: string[] = [];

    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)} type="button">移除成员</button>
          <SystemDialog
            actions={[
              {id: "cancel", intent: "secondary", kind: "cancel", label: "取消"},
              {id: "remove", intent: "destructive", kind: "action", label: "确认移除"},
            ]}
            description="移出后，该成员将无法继续收发消息。"
            dialogId="remove-member-dialog"
            onAction={id => actions.push(id)}
            onOpenChange={(next, reason) => {
              closes.push(reason);
              setOpen(next);
            }}
            open={open}
            title="移出成员？"
          />
        </>
      );
    }

    render(<Harness />);
    const trigger = screen.getByRole("button", {name: "移除成员"});
    trigger.focus();
    fireEvent.click(trigger);

    expect(screen.getByRole("dialog", {name: "移出成员？"})).not.toBeNull();
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole("button", {name: "取消"}));
    });
    fireEvent.click(screen.getByRole("button", {name: "取消"}));

    expect(actions).toEqual(["cancel"]);
    expect(closes).toEqual(["cancel"]);
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("closes with Escape and never treats a routine confirmation as alertdialog", () => {
    const {SystemDialog} = require(
      "./system-dialog.web"
    ) as typeof import("./system-dialog.web");
    const onOpenChange = jest.fn();
    render(
      <SystemDialog
        actions={[
          {id: "cancel", intent: "secondary", kind: "cancel", label: "取消"},
          {id: "delete", intent: "destructive", kind: "action", label: "删除"},
        ]}
        description="此操作不可撤销。"
        dialogId="delete-dialog"
        onAction={jest.fn()}
        onOpenChange={onOpenChange}
        open
        title="删除 Agent？"
      />,
    );

    const dialog = screen.getByRole("dialog", {name: "删除 Agent？"});
    expect(screen.queryByRole("alertdialog")).toBeNull();
    fireEvent.keyDown(dialog, {key: "Escape"});
    expect(onOpenChange).toHaveBeenCalledWith(false, "escape");
  });
});
