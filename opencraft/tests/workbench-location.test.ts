import assert from "node:assert/strict";
import test from "node:test";

import {
  createConversationScopeRegistry,
  createWorkbenchDraftLocation,
  createWorkbenchThreadLocation,
  encodeWorkbenchLocation,
  equalWorkbenchLocation,
  parseWorkbenchLocation,
  serializeWorkbenchLocation,
} from "@opencraft/workbench-runtime";
import {
  createApplicationNavigation,
  parseApplicationRouteUrl,
  parseWorkbenchLocationUrl,
  workbenchLocationUrl,
} from "../apps/workbench-web/src/runtime/workbench-navigation";
import { createWorkbenchNavigationTransaction } from "../apps/workbench-web/src/runtime/workbench-navigation-transaction";

test("Workbench Thread identity includes Host and survives URL round trips", () => {
  const first = createWorkbenchThreadLocation("ssh:alpha", "thread/42");
  const second = createWorkbenchThreadLocation("ssh:beta", "thread/42");

  assert.notEqual(
    encodeWorkbenchLocation(first),
    encodeWorkbenchLocation(second),
  );
  assert.equal(equalWorkbenchLocation(first, second), false);
  assert.deepEqual(
    parseWorkbenchLocationUrl(
      new URL(workbenchLocationUrl(first), "https://vela.test"),
    ),
    first,
  );
});

test("Workbench Draft identity remains stable before AppServer promotion", () => {
  const draft = createWorkbenchDraftLocation("durable", "draft:a/b");
  const serialized = serializeWorkbenchLocation(draft);

  assert.deepEqual(parseWorkbenchLocation(serialized), draft);
  assert.deepEqual(
    parseWorkbenchLocationUrl(
      new URL(workbenchLocationUrl(draft), "https://vela.test"),
    ),
    draft,
  );
});

test("malformed or Host-less workbench URLs do not invent ownership", () => {
  assert.equal(
    parseWorkbenchLocationUrl(new URL("https://vela.test/local/thread-a")),
    null,
  );
  assert.equal(
    parseWorkbenchLocationUrl(new URL("https://vela.test/?hostId=local")),
    null,
  );
  assert.equal(
    parseWorkbenchLocation({ kind: "draft", hostId: "", draftId: "x" }),
    null,
  );
});

test("Web replace creates a new View unless Draft promotion explicitly preserves it", () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const history = {
    state: null as unknown,
    replaceState(next: unknown) {
      this.state = next;
    },
    pushState(next: unknown) {
      this.state = next;
    },
    back() {},
    forward() {},
    go() {},
  };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: { href: "https://vela.test/?hostId=local&draftId=draft-a" },
      history,
      addEventListener() {},
      removeEventListener() {},
    },
  });
  const navigation = createApplicationNavigation(
    createWorkbenchDraftLocation("local", "draft-a"),
  );
  try {
    const initialViewId = navigation.getSnapshot().routeScopeId;
    navigation.replace(createWorkbenchDraftLocation("local", "draft-b"));
    const replacementViewId = navigation.getSnapshot().routeScopeId;
    assert.notEqual(replacementViewId, initialViewId);

    navigation.replace(
      createWorkbenchThreadLocation("local", "thread-promoted"),
      { preserveView: true },
    );
    assert.equal(navigation.getSnapshot().routeScopeId, replacementViewId);
  } finally {
    navigation.dispose();
    if (previousWindow === undefined)
      delete (globalThis as { window?: unknown }).window;
    else Object.defineProperty(globalThis, "window", previousWindow);
  }
});

test("Settings and extension routes have real history; Chat is an explicit destination", async () => {
  const location = createWorkbenchThreadLocation("local", "thread-a");
  const navigation = createApplicationNavigation(location, { mode: "memory" });
  try {
    const scope = navigation.getSnapshot().routeScopeId;
    navigation.openSettings("connections");
    navigation.openSettings("appearance");
    assert.equal(navigation.getSnapshot().historyIndex, 2);
    navigation.openExtensionView("vela.drive.files", "folder-a");
    assert.equal(navigation.getSnapshot().historyIndex, 3);
    navigation.back(); await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(navigation.getSnapshot().applicationRoute, { kind: "settings", slug: "appearance" });
    assert.equal(navigation.getSnapshot().canGoForward, true);
    navigation.forward(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(navigation.getSnapshot().applicationRoute.kind, "extension-view");
    navigation.openChat();
    assert.equal(navigation.getSnapshot().applicationRoute.kind, "conversation");
    assert.deepEqual(navigation.getSnapshot().location, location);
    assert.equal(navigation.getSnapshot().routeScopeId, scope);
    navigation.back(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(navigation.getSnapshot().applicationRoute.kind, "extension-view");
  } finally { navigation.dispose(); }
});

test("navigateToHome presents a local Draft before Host preparation settles", async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const urls: string[] = [];
  const initialLocation = createWorkbenchThreadLocation("local", "thread-a");
  const history = {
    state: null as unknown,
    replaceState(next: unknown, _unused: string, url: string) {
      this.state = next;
      urls.push(url);
    },
    pushState(next: unknown, _unused: string, url: string) {
      this.state = next;
      urls.push(url);
    },
    back() {},
    forward() {},
    go() {},
  };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: { href: "https://vela.test/settings/lightvela.hermes.skills" },
      history,
      addEventListener() {},
      removeEventListener() {},
    },
  });
  const scopes = createConversationScopeRegistry();
  const draft = scopes.openDraft({
    entrypoint: "new-chat",
    execution: {
      hostId: "local",
      workspace: { cwd: null, runtimeWorkspaceRoots: [] },
    },
  });
  const location = createWorkbenchDraftLocation("local", draft.id);
  let presented: { location: typeof location; viewId: string } | null = null;
  let resolvePreparation: ((value: null) => void) | null = null;
  const activation = {
    presentLocalDraft(nextLocation: typeof location, viewId: string) {
      presented = { location: nextLocation, viewId };
    },
    prepare() {
      return new Promise<null>((resolve) => {
        resolvePreparation = resolve;
      });
    },
    setViewId() {}, cancelPending() {},
    dispose() {},
  };
  const navigation = createWorkbenchNavigationTransaction(
    initialLocation,
    activation as never,
    scopes,
  );
  try {
    navigation.navigateToHome(location);

    assert.deepEqual(navigation.getSnapshot().applicationRoute, {
      kind: "conversation",
    });
    assert.deepEqual(navigation.getSnapshot().location, location);
    assert.equal(
      navigation.getSnapshot().url,
      `/?hostId=local&draftId=${encodeURIComponent(draft.id)}`,
    );
    assert.deepEqual(presented?.location, location);

    resolvePreparation?.(null);
    await Promise.resolve();
    assert.deepEqual(navigation.getSnapshot().applicationRoute, {
      kind: "conversation",
    });
  } finally {
    navigation.dispose();
    scopes.dispose();
    if (previousWindow === undefined)
      delete (globalThis as { window?: unknown }).window;
    else Object.defineProperty(globalThis, "window", previousWindow);
  }
});

test("Extension View routes round-trip without inventing a Conversation location", () => {
  const url = new URL("https://vela.test/views/vela.drive.files");
  assert.deepEqual(parseApplicationRouteUrl(url), {
    kind: "extension-view",
    viewId: "vela.drive.files",
    resourceUri: null,
  });
  assert.equal(parseWorkbenchLocationUrl(url), null);
});

test("Extension View resources round-trip and can be canonically replaced", () => {
  const resourceUri =
    "vela-bot:conversation?hostId=host-a&conversationId=conversation-a";
  const url = new URL(
    `https://vela.test/views/vela.bot-chat.view?resource=${encodeURIComponent(resourceUri)}`,
  );
  assert.deepEqual(parseApplicationRouteUrl(url), {
    kind: "extension-view",
    viewId: "vela.bot-chat.view",
    resourceUri,
  });
});

test("an active Extension View can push and pop resources without losing Chat destination", async () => {
  const location = createWorkbenchThreadLocation("local", "thread-a");
  const navigation = createApplicationNavigation(location, { mode: "memory" });
  try {
    navigation.openExtensionView("workspace", "channel");
    navigation.pushExtensionViewResource("workspace", "thread");
    assert.equal(navigation.getSnapshot().historyIndex, 2);
    navigation.back(); await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(navigation.getSnapshot().applicationRoute, { kind: "extension-view", viewId: "workspace", resourceUri: "channel" });
    navigation.forward(); await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(navigation.getSnapshot().applicationRoute, { kind: "extension-view", viewId: "workspace", resourceUri: "thread" });
    navigation.replaceExtensionViewResource("workspace", "renamed");
    assert.equal(navigation.getSnapshot().historyIndex, 2);
    navigation.openChat();
    assert.equal(navigation.getSnapshot().applicationRoute.kind, "conversation");
    assert.deepEqual(navigation.getSnapshot().location, location);
  } finally { navigation.dispose(); }
});
