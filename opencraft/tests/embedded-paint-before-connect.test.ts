import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { isEmbeddedConversationPainted } from "../apps/workbench-web/src/embedded-chat/embedded-paint";

Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: { location: { href: "https://ui.example/", protocol: "https:" } },
});
const { activeThreadStorageKey, rememberedThreadId } = await import(
  "../apps/workbench-web/src/runtime/appserver-runtime-context"
);

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("the embedded Draft paints before the Host connects; sending stays gated", () => {
  const element = read("../apps/workbench-web/src/embedded-chat/embedded-workbench-element.tsx");
  const prepareOwned = element.slice(element.indexOf("private async prepareOwned"), element.indexOf("private handlePainted"));
  assert.ok(prepareOwned.length > 0, "prepareOwned should exist");
  // prepare()/show() resolve on paint; awaiting the connection here re-hides the Composer behind the host overlay.
  assert.doesNotMatch(prepareOwned, /await this\.connection\.ready/u);
  assert.ok(prepareOwned.indexOf("this.renderApplication()") < prepareOwned.indexOf("await this.paintedPromise"));
  const show = element.slice(element.indexOf("async show()"), element.indexOf("hide()"));
  assert.match(show, /await this\.paintedPromise/u);
  assert.doesNotMatch(show, /await this\.readyPromise/u);

  const app = read("../apps/workbench-web/src/app.tsx");
  assert.match(app, /const painted = isEmbeddedConversationPainted\(draft, conversationViewActivation\.phase\);/u);

  const draft = read("../apps/workbench-web/src/components/new-thread-draft-page.tsx");
  assert.match(draft, /submissionDisabled=\{connectionPhase !== "ready"\}/u);
});

test("a startup that restores a stored session ID paints once its Thread view is ready", () => {
  const hostId = "embedded:ins-1:profile-1";
  const stored = new Map([[activeThreadStorageKey(hostId), "thread:stored-session"]]);
  const storage = { getItem: (key: string) => stored.get(key) ?? null };
  assert.equal(rememberedThreadId(storage, hostId, "configured"), "thread:stored-session");

  // A remembered Thread location means startup builds no Draft (initialDraft: null).
  const runtime = read("../apps/workbench-web/src/runtime/appserver-runtime-context.tsx");
  assert.match(runtime, /initialDraft: initialThreadLocation === null\s*\?/u);
  const restoredDraft = null;

  assert.equal(isEmbeddedConversationPainted(restoredDraft, "resolving"), false);
  assert.equal(isEmbeddedConversationPainted(restoredDraft, "ready"), true);
  assert.equal(isEmbeddedConversationPainted({ submission: null }, "resolving"), true);
  assert.equal(isEmbeddedConversationPainted({ submission: { id: "turn-1" } }, "resolving"), false);
});
