import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import React, { act, Suspense, useEffect, useLayoutEffect } from "react";
import { JSDOM } from "jsdom";
import { spawnSync } from "node:child_process";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
  React,
});
// The library selects its browser/native commit effect at module initialization.
const { createRoot } = await import("react-dom/client");
const { useStableEvent } = await import("@opencraft/react-runtime");
const { useTurnHistoryBackfill } = await import("@opencraft/timeline-react");

function fixture(t: TestContext) {
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  t.after(async () => {
    await act(() => root.unmount());
    element.remove();
  });
  return {
    root,
    element,
    render: (children: React.ReactNode) => act(() => root.render(children)),
  };
}

test("a subscribed command keeps its identity and sees the committed callback before layout", async t => {
  const view = fixture(t);
  const layoutValues: number[] = [];
  const commands: Array<(input: number) => number> = [];
  let subscriptions = 0;
  let disposals = 0;
  function Consumer({ value }: { value: number }) {
    const command = useStableEvent((input: number) => value + input);
    useLayoutEffect(() => {
      commands.push(command);
      layoutValues.push(command(10));
    });
    useEffect(() => {
      subscriptions += 1;
      return () => { disposals += 1; };
    }, [command]);
    return <span>{value}</span>;
  }
  await view.render(<Consumer value={1} />);
  await view.render(<Consumer value={2} />);
  assert.equal(commands[0], commands[1]);
  assert.deepEqual(layoutValues, [11, 12]);
  assert.equal(commands[0](20), 22);
  assert.equal(subscriptions, 1);
  assert.equal(disposals, 0);
});

test("a suspended render cannot publish its callback or overwrite a later committed one", async t => {
  const view = fixture(t);
  const rendered: number[] = [];
  const pending = new Promise<void>(() => {});
  let command!: () => number;
  function Consumer({ value }: { value: number }) {
    const current = useStableEvent(() => value);
    rendered.push(value);
    useLayoutEffect(() => { command = current; });
    if (value === 2) throw pending;
    return <span>{value}</span>;
  }
  const tree = (value: number) => <Suspense fallback="waiting"><Consumer value={value} /></Suspense>;
  await view.render(tree(1));
  const original = command;
  await act(() => { React.startTransition(() => view.root.render(tree(2))); });
  assert.ok(rendered.includes(2), "the replacement render must actually have suspended");
  assert.equal(view.element.textContent, "1");
  assert.equal(command(), 1);
  await view.render(tree(3));
  assert.equal(command, original);
  assert.equal(command(), 3);
});

test("StrictMode replay retains the command while a new mount gets its own owner", async t => {
  const view = fixture(t);
  const values: number[] = [];
  let command!: () => number;
  function Consumer({ value }: { value: number }) {
    const current = useStableEvent(() => value);
    useLayoutEffect(() => {
      command = current;
      values.push(current());
    });
    return null;
  }
  await view.render(<React.StrictMode><Consumer value={1} /></React.StrictMode>);
  const first = command;
  assert.ok(values.length >= 2, "development StrictMode must replay layout setup");
  await view.render(<React.StrictMode><Consumer value={2} /></React.StrictMode>);
  assert.equal(command, first);
  assert.equal(command(), 2);
  await view.render(null);
  await view.render(<Consumer value={3} />);
  assert.notEqual(command, first);
  assert.equal(command(), 3);
});

test("commands forward arguments, promise identity and thrown errors", async t => {
  const view = fixture(t);
  const result = Promise.resolve("complete");
  const failure = new Error("operation failed");
  let command!: (input: string, fail?: boolean) => Promise<string>;
  function Consumer() {
    const current = useStableEvent((input: string, fail = false) => {
      assert.equal(input, "payload");
      if (fail) throw failure;
      return result;
    });
    useLayoutEffect(() => { command = current; });
    return null;
  }
  await view.render(<Consumer />);
  assert.equal(command("payload"), result);
  assert.throws(() => command("payload", true), error => error === failure);
});

test("an initial render cannot invoke an event before its first commit", async t => {
  const view = fixture(t);
  let failure: unknown;
  function Consumer() {
    const command = useStableEvent(() => "not committed");
    try { command(); } catch (error) { failure = error; }
    return null;
  }
  await view.render(<Consumer />);
  assert.match(String(failure), /cannot be invoked before the component has mounted/);
});

test("server rendering without browser globals does not invoke a client command", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", `
    import assert from 'node:assert/strict';
    import React from 'react';
    import {renderToString} from 'react-dom/server';
    assert.equal(typeof window, 'undefined');
    const {useStableEvent} = await import('@opencraft/react-runtime');
    let invocations = 0;
    function Consumer() {
      const command = useStableEvent(() => { invocations += 1; });
      React.useLayoutEffect(() => { command(); }, [command]);
      return React.createElement('span', null, 'server content');
    }
    assert.equal(renderToString(React.createElement(Consumer)), '<span>server content</span>');
    assert.equal(invocations, 0);
  `], { encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr);
});

test("history backfill uses the updated committed loader without replacing its observer command", async t => {
  const view = fixture(t);
  const loads: number[] = [];
  const commands: Array<() => Promise<void>> = [];
  function Consumer({ version }: { version: number }) {
    const history = useTurnHistoryBackfill({
      historyKey: "same-conversation",
      loadPage: async () => { loads.push(version); return "stop"; },
      readMetrics: () => ({ viewportHeight: 500, contentHeight: 100, scrollTop: 0 }),
      afterLayout: async () => {},
    });
    useLayoutEffect(() => { commands.push(history.request); });
    return null;
  }
  await view.render(<Consumer version={1} />);
  await commands[0]();
  await view.render(<Consumer version={2} />);
  await commands[0]();
  assert.equal(commands[0], commands[1]);
  assert.deepEqual(loads, [1, 2]);
});
