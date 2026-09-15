import assert from "node:assert/strict";
import test from "node:test";

import {
  createWorkbenchDraftLocation,
  createWorkbenchThreadLocation,
  encodeWorkbenchLocation,
  equalWorkbenchLocation,
  parseWorkbenchLocation,
  serializeWorkbenchLocation,
} from "@opencraft/workbench-runtime";
import {
  createBrowserWorkbenchNavigation,
  parseApplicationRouteUrl,
  parseWorkbenchLocationUrl,
  workbenchLocationUrl,
} from "../apps/workbench-web/src/runtime/workbench-navigation";

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
  const navigation = createBrowserWorkbenchNavigation(
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

test("Settings is a top-level application route that preserves return identity", () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const urls: string[] = [];
  const historyDeltas: number[] = [];
  let pushedEntries = 0;
  const history = {
    state: null as unknown,
    replaceState(next: unknown, _unused: string, url: string) {
      this.state = next;
      urls.push(url);
    },
    pushState(next: unknown, _unused: string, url: string) {
      this.state = next;
      pushedEntries += 1;
      urls.push(url);
    },
    back() {},
    forward() {},
    go(delta: number) {
      historyDeltas.push(delta);
    },
  };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: { href: "https://vela.test/local/thread-a?hostId=local" },
      history,
      addEventListener() {},
      removeEventListener() {},
    },
  });
  const location = createWorkbenchThreadLocation("local", "thread-a");
  const navigation = createBrowserWorkbenchNavigation(location);
  try {
    const conversationViewId = navigation.getSnapshot().routeScopeId;
    navigation.openSettings("connections");
    assert.deepEqual(navigation.getSnapshot().applicationRoute, {
      kind: "settings",
      slug: "connections",
    });
    assert.deepEqual(navigation.getSnapshot().location, location);
    assert.equal(navigation.getSnapshot().routeScopeId, conversationViewId);
    assert.equal(urls.at(-1), "/settings/connections");

    const settingsHistoryIndex = navigation.getSnapshot().historyIndex;
    navigation.openSettings("appearance");
    assert.deepEqual(navigation.getSnapshot().applicationRoute, {
      kind: "settings",
      slug: "appearance",
    });
    assert.equal(urls.at(-1), "/settings/appearance");
    assert.equal(
      navigation.getSnapshot().historyIndex,
      settingsHistoryIndex,
      "switching settings sections replaces the settings history entry",
    );
    assert.equal(pushedEntries, 1);

    navigation.openExtensionView("vela.drive.files");
    assert.deepEqual(navigation.getSnapshot().applicationRoute, {
      kind: "extension-view",
      viewId: "vela.drive.files",
      resourceUri: null,
    });
    assert.equal(urls.at(-1), "/views/vela.drive.files");
    assert.equal(pushedEntries, 1, "switching application surfaces replaces one owned entry");

    const resourceUri =
      "vela-bot:conversation?hostId=host-a&conversationId=conversation-a";
    navigation.replaceExtensionViewResource("vela.drive.files", resourceUri);
    assert.deepEqual(navigation.getSnapshot().applicationRoute, {
      kind: "extension-view",
      viewId: "vela.drive.files",
      resourceUri,
    });
    assert.equal(
      urls.at(-1),
      `/views/vela.drive.files?resource=${encodeURIComponent(resourceUri)}`,
    );

    navigation.openSettings("extension:lightvela/account");
    assert.deepEqual(navigation.getSnapshot().applicationRoute, {
      kind: "settings",
      slug: "extension:lightvela/account",
    });
    assert.equal(
      urls.at(-1),
      "/settings/extension%3Alightvela%2Faccount",
    );

    navigation.closeSettings();
    assert.deepEqual(
      historyDeltas,
      [-1],
      "Back to app exits the single settings entry instead of visiting prior sections",
    );

    navigation.push(location);
    assert.deepEqual(navigation.getSnapshot().applicationRoute, {
      kind: "conversation",
    });
    assert.equal(urls.at(-1), "/local/thread-a?hostId=local");
  } finally {
    navigation.dispose();
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
