import assert from "node:assert/strict";
import test from "node:test";
import { MemoryUiPreferenceStore, UiPreferencesRuntime } from "../../packages/ui-preferences/src/index.ts";
import { bindInteractionDensity } from "../../apps/workbench-web/src/runtime/interaction-density.ts";

test("automatic density follows capability; persisted overrides win and reset resumes detection", async () => {
  const store = new MemoryUiPreferenceStore();
  let runtime = await UiPreferencesRuntime.open({ installation: store });
  const listeners = new Set<() => void>();
  const query = { matches: true, addEventListener: (_: string, cb: () => void) => listeners.add(cb), removeEventListener: (_: string, cb: () => void) => listeners.delete(cb) };
  const root = { dataset: {} as Record<string, string> };
  const document = { documentElement: root, defaultView: { matchMedia: () => query } } as unknown as Document;
  let dispose = bindInteractionDensity(document, runtime);
  assert.equal(root.dataset.uiDensity, "touch");
  query.matches = false; listeners.forEach(cb => cb());
  assert.equal(root.dataset.uiDensity, "compact");
  await runtime.set("interface.touchFriendly", "on");
  assert.equal(root.dataset.uiDensity, "touch");
  await runtime.set("interface.touchFriendly", "off");
  query.matches = true; listeners.forEach(cb => cb());
  assert.equal(root.dataset.uiDensity, "compact");
  dispose(); await runtime.close();
  runtime = await UiPreferencesRuntime.open({ installation: store });
  dispose = bindInteractionDensity(document, runtime);
  assert.equal(root.dataset.uiDensity, "compact");
  await runtime.set("interface.touchFriendly", "auto");
  assert.equal(root.dataset.uiDensity, "touch");
  dispose(); assert.equal(root.dataset.uiDensity, undefined); assert.equal(listeners.size, 0);
  await runtime.close();
});


test("Newera stays opt-in and projects persisted presentation without changing density", async () => {
  const store = new MemoryUiPreferenceStore();
  let runtime = await UiPreferencesRuntime.open({ installation: store });
  const root = { dataset: {} as Record<string, string> };
  const query = { matches: false, addEventListener() {}, removeEventListener() {} };
  const document = { documentElement: root, defaultView: { matchMedia: () => query } } as unknown as Document;
  let dispose = bindInteractionDensity(document, runtime);
  assert.equal(root.dataset.touchNewera, "off");
  await runtime.set("chat.touchNewera", true);
  assert.equal(root.dataset.touchNewera, "on");
  assert.equal(root.dataset.uiDensity, "compact");
  dispose(); assert.equal(root.dataset.touchNewera, undefined); await runtime.close();
  runtime = await UiPreferencesRuntime.open({ installation: store });
  dispose = bindInteractionDensity(document, runtime);
  assert.equal(runtime.get("chat.touchNewera"), true);
  assert.equal(root.dataset.touchNewera, "on");
  await runtime.set("chat.touchNewera", false);
  assert.equal(root.dataset.touchNewera, "off");
  dispose(); await runtime.close();
});
