import assert from "node:assert/strict";
import test from "node:test";
import { createClientRuntime, resolveClientRuntimeKind, WebRuntime, PwaRuntime, ElectronRuntime } from "../../apps/workbench-web/src/runtime/client-runtime";

function fixture(options: { apple?: boolean; cssStandalone?: boolean; electron?: boolean; embedded?: boolean } = {}) {
  const target = new EventTarget();
  let fullscreen = false;
  let listener: ((value: boolean) => void) | undefined;
  let subscriptions = 0, releases = 0;
  const view: any = Object.assign(new EventTarget(), { navigator: { standalone: options.apple }, innerWidth: 390,
    matchMedia: (query: string) => ({ matches: options.cssStandalone === true && query === "(display-mode: standalone)" }),
    opencraftDesktop: options.electron ? { kind: "electron", getWindowFullscreen: () => fullscreen,
      onWindowFullscreenChanged: (next: (value: boolean) => void) => { subscriptions++; listener = next; return () => { releases++; listener = undefined; }; } } : undefined });
  view.top = options.embedded ? {} : view;
  const document = Object.assign(target, { defaultView: view, documentElement: { dataset: {}, clientWidth: 390 } }) as unknown as Document;
  const runtime = createClientRuntime(document);
  const touch = (clientX: number) => {
    const event = new Event("touchstart", { cancelable: true });
    Object.defineProperties(event, { touches: { value: [{ clientX }] }, changedTouches: { value: [{ clientX }] } });
    view.dispatchEvent(event); return event.defaultPrevented;
  };
  return { document, runtime, view, touch,
    fullscreen(value: boolean) { fullscreen = value; listener?.(value); }, counts: () => ({ subscriptions, releases }) };
}

test("runtime selection separates browser/PWA presentation from the Electron bridge", () => {
  for (const [options, kind, Constructor] of [
    [{}, "web", WebRuntime], [{ apple: true }, "pwa", PwaRuntime],
    [{ cssStandalone: true }, "pwa", PwaRuntime], [{ apple: true, electron: true }, "electron", ElectronRuntime],
    [{ apple: true, embedded: true }, "web", WebRuntime],
  ] as const) {
    const f = fixture(options);
    assert.equal(resolveClientRuntimeKind(f.view), kind); assert.equal(f.runtime.kind, kind);
    assert.ok(f.runtime instanceof Constructor);
    assert.equal(f.touch(1), false, "construction never installs input resources");
  }
});

test("only Apple PwaRuntime reserves both edges, with idempotent retirement and no fake history", () => {
  const pwa = fixture({ apple: true });
  pwa.runtime.start(); pwa.runtime.start();
  assert.equal(pwa.document.documentElement.dataset.clientRuntime, "pwa");
  assert.equal(pwa.touch(1), true); assert.equal(pwa.touch(389), true); assert.equal(pwa.touch(195), false);
  pwa.runtime.dispose(); pwa.runtime.dispose();
  assert.equal(pwa.touch(1), false); assert.equal(pwa.touch(389), false);
  assert.equal(pwa.document.documentElement.dataset.clientRuntime, undefined);
  assert.throws(() => pwa.runtime.start(), /retired/);
  for (const options of [{}, { cssStandalone: true }, { apple: true, embedded: true }, { apple: true, electron: true }]) {
    const f = fixture(options); f.runtime.start();
    assert.equal(f.touch(1), false); assert.equal(f.touch(389), false); f.runtime.dispose();
  }
});

test("ElectronRuntime owns subscribe-before-read fullscreen state and releases the preload subscription", () => {
  const f = fixture({ electron: true });
  const port = f.view.opencraftDesktop;
  const subscribe = port.onWindowFullscreenChanged;
  port.onWindowFullscreenChanged = (next: (value: boolean) => void) => { const release = subscribe(next); f.fullscreen(true); return release; };
  f.runtime.start(); f.runtime.start();
  assert.equal(f.document.documentElement.dataset.opencraftWindowFullscreen, "true");
  assert.deepEqual(f.counts(), { subscriptions: 1, releases: 0 });
  f.fullscreen(false); assert.equal(f.document.documentElement.dataset.opencraftWindowFullscreen, "false");
  f.runtime.dispose(); assert.deepEqual(f.counts(), { subscriptions: 1, releases: 1 });
});
