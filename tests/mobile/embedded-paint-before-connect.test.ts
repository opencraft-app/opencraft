import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { isEmbeddedConversationPainted } from "../../apps/workbench-web/src/embedded-chat/embedded-paint";

Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: {
    location: { href: "https://ui.example/", protocol: "https:", search: "" },
    history: { replaceState() {} },
  },
});
const { activeThreadStorageKey, rememberedThreadId } = await import(
  "../../apps/workbench-web/src/runtime/appserver-runtime-context"
);

const read = (path: string) => readFileSync(new URL(path, new URL("../", import.meta.url)), "utf8");

test("a startup that restores a stored session ID paints once its Thread view is ready", () => {
  const hostId = "embedded:ins-1:profile-1";
  const stored = new Map([[activeThreadStorageKey(hostId), "thread:stored-session"]]);
  const storage = { getItem: (key: string) => stored.get(key) ?? null };
  assert.equal(rememberedThreadId(storage, hostId, "configured"), "thread:stored-session");

  // A remembered Thread location means startup builds no Draft (initialDraft: null).
  const runtime = read("../apps/workbench-web/src/runtime/web-workbench-supervisor.ts");
  assert.match(runtime, /initialDraft: initialThreadLocation === null\s*\?/u);
  const restoredDraft = null;

  assert.equal(isEmbeddedConversationPainted(restoredDraft, "resolving"), false);
  assert.equal(isEmbeddedConversationPainted(restoredDraft, "ready"), true);
  assert.equal(isEmbeddedConversationPainted({ submission: null }, "resolving"), true);
  assert.equal(isEmbeddedConversationPainted({ submission: { id: "turn-1" } }, "resolving"), false);
});

test("embedded sessions wait for the initial catalog unless the Host has failed", () => {
  const app = read("../apps/workbench-web/src/app.tsx");
  const runtime = read("../apps/workbench-web/src/runtime/appserver-runtime-context.tsx");
  assert.match(runtime, /isPending: query\.isPending/u);
  assert.match(app, /loading: \(catalog\.isPending && snapshot\.phase !== "error"\) \|\| catalog\.isFetching/u);
  assert.match(app, /snapshot\.phase\]\);/u);
});
