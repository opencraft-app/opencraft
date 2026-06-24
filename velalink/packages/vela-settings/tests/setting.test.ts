import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";

import { useVelaSetting, type VelaSetting } from "../src/index";

function installDom() {
  const window = new Window();
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: window,
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: window.document,
  });
  Object.defineProperty(globalThis, "HTMLElement", {
    configurable: true,
    value: window.HTMLElement,
  });
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

test("useVelaSetting loads a setting and saves changed values immediately", async () => {
  installDom();

  const saved: string[] = [];
  const snapshots: Array<{ status: string; value: string | undefined }> = [];
  let changeValue: ((value: string) => Promise<void>) | undefined;

  const setting: VelaSetting<string> = {
    id: "appearance.theme",
    title: "Theme",
    control: "select",
    options: [
      { label: "Light", value: "light" },
      { label: "Dark", value: "dark" },
    ],
    load: () => "light",
    save: async (value) => {
      saved.push(value);
    },
  };

  function Harness() {
    const state = useVelaSetting(setting);
    changeValue = state.setValue;
    React.useEffect(() => {
      snapshots.push({ status: state.status, value: state.value });
    }, [state.status, state.value]);
    return null;
  }

  const root = createRoot(document.createElement("div"));
  await act(async () => {
    root.render(React.createElement(Harness));
  });
  await flush();

  assert.deepEqual(snapshots.at(-1), { status: "ready", value: "light" });

  await act(async () => {
    await changeValue?.("dark");
  });

  assert.deepEqual(saved, ["dark"]);
  assert.deepEqual(snapshots.at(-1), { status: "ready", value: "dark" });
});

test("useVelaSetting keeps the edited value and exposes errors when save fails", async () => {
  installDom();

  let changeValue: ((value: boolean) => Promise<void>) | undefined;
  let latest:
    | {
        error: Error | null;
        status: string;
        value: boolean | undefined;
      }
    | undefined;

  const setting: VelaSetting<boolean> = {
    id: "runtime.keepAwake",
    title: "Keep awake",
    control: "switch",
    load: () => false,
    save: async () => {
      throw new Error("host unavailable");
    },
  };

  function Harness() {
    const state = useVelaSetting(setting);
    changeValue = state.setValue;
    React.useEffect(() => {
      latest = {
        error: state.error,
        status: state.status,
        value: state.value,
      };
    }, [state.error, state.status, state.value]);
    return null;
  }

  const root = createRoot(document.createElement("div"));
  await act(async () => {
    root.render(React.createElement(Harness));
  });
  await flush();

  await act(async () => {
    await changeValue?.(true);
  });

  assert.equal(latest?.status, "error");
  assert.equal(latest?.value, true);
  assert.equal(latest?.error?.message, "host unavailable");
});
