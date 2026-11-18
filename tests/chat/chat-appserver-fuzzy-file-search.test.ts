import assert from "node:assert/strict";
import test from "node:test";

import {
  AppServerRpcError,
  type AppServerClient,
} from "@opencraft/appserver-client";
import type { AppServerNotification } from "@opencraft/appserver-protocol";
import { AppServerFuzzyFileSearchController } from "@opencraft/composer-appserver";

interface RecordedRequest {
  readonly method: string;
  readonly params: unknown;
}

function createClient(
  request: (method: string, params: unknown) => Promise<unknown>,
): {
  readonly client: AppServerClient;
  readonly emit: (notification: AppServerNotification) => void;
} {
  const listeners = new Set<(notification: AppServerNotification) => void>();
  return {
    client: {
      request,
      subscribeNotification(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    } as unknown as AppServerClient,
    emit(notification) {
      for (const listener of listeners) listener(notification);
    },
  };
}

test("fuzzy file search keeps one AppServer session across query updates", async () => {
  const requests: RecordedRequest[] = [];
  const { client, emit } = createClient(async (method, params) => {
    requests.push({ method, params });
    return {};
  });
  const updates: unknown[] = [];
  let completed = 0;
  const controller = new AppServerFuzzyFileSearchController(client, {
    createSessionId: () => "search:1",
  });
  const session = await controller.createSession({
    roots: ["/repo", "/repo"],
    onUpdated: (update) => updates.push(update),
    onCompleted: () => { completed += 1; },
  });

  await session.update("app");
  emit({
    method: "fuzzyFileSearch/sessionUpdated",
    params: {
      sessionId: "search:1",
      query: "app",
      files: [{
        root: "/repo",
        path: "src/app.tsx",
        match_type: "file",
        file_name: "app.tsx",
        score: 42,
        indices: [4, 5, 6],
      }],
    },
  });
  emit({ method: "fuzzyFileSearch/sessionCompleted", params: { sessionId: "search:1" } });
  await session.stop();

  assert.deepEqual(requests.map((entry) => entry.method), [
    "fuzzyFileSearch/sessionStart",
    "fuzzyFileSearch/sessionUpdate",
    "fuzzyFileSearch/sessionStop",
  ]);
  assert.deepEqual(requests[0]?.params, { sessionId: "search:1", roots: ["/repo"] });
  assert.equal((updates[0] as { query: string }).query, "app");
  assert.equal(completed, 1);
  controller.dispose();
});

test("fuzzy file search detects old AppServers once and falls back to one-shot search", async () => {
  const requests: RecordedRequest[] = [];
  const { client } = createClient(async (method, params) => {
    requests.push({ method, params });
    if (method === "fuzzyFileSearch/sessionStart") {
      throw new AppServerRpcError({ code: -32601, message: "Method not found: fuzzyFileSearch/sessionStart" });
    }
    if (method === "fuzzyFileSearch") {
      return {
        files: [{
          root: "/repo",
          path: "README.md",
          match_type: "file",
          file_name: "README.md",
          score: 8,
          indices: [0],
        }],
      };
    }
    return {};
  });
  const updates: string[] = [];
  const controller = new AppServerFuzzyFileSearchController(client, {
    createSessionId: () => `search:${requests.length}`,
  });
  const first = await controller.createSession({
    roots: ["/repo"],
    onUpdated: (update) => updates.push(update.files[0]?.path ?? ""),
  });
  await first.update("read");
  await first.stop();
  const second = await controller.createSession({ roots: ["/other"] });
  await second.update("src");

  assert.deepEqual(requests.map((entry) => entry.method), [
    "fuzzyFileSearch/sessionStart",
    "fuzzyFileSearch",
    "fuzzyFileSearch",
  ]);
  assert.equal(updates[0], "README.md");
  controller.dispose();
});

test("opening or clearing an empty search does not build a file index", async () => {
  const requests: RecordedRequest[] = [];
  const { client } = createClient(async (method, params) => {
    requests.push({ method, params });
    return {};
  });
  const controller = new AppServerFuzzyFileSearchController(client);
  const session = await controller.createSession({ roots: ["/repo"] });
  await session.update(" ");
  assert.equal(requests.length, 0);
  await session.update("file");
  await session.update("");
  assert.deepEqual(requests.map(r => r.method), [
    "fuzzyFileSearch/sessionStart", "fuzzyFileSearch/sessionUpdate", "fuzzyFileSearch/sessionStop",
  ]);
  await session.update("again");
  assert.equal(requests[3]?.method, "fuzzyFileSearch/sessionStart");
  controller.dispose();
});

test("whole-machine and kernel search roots are rejected before an RPC", async () => {
  const requests: RecordedRequest[] = [];
  const { client } = createClient(async (method, params) => {
    requests.push({ method, params });
    return {};
  });
  const controller = new AppServerFuzzyFileSearchController(client);
  for (const root of ["/", "/data", "/sys/devices", "/proc", "/dev", "/repo/../", ".", "C:\\", "C:\\repo\\..", "//server/share"]) {
    await assert.rejects(controller.createSession({ roots: [root] }), /project directory/u, root);
  }
  assert.equal(requests.length, 0);
  controller.dispose();
});

test("disposing a controller stops every started search and prevents later updates", async () => {
  const requests: RecordedRequest[] = [];
  const { client } = createClient(async (method, params) => {
    requests.push({ method, params });
    return {};
  });
  const controller = new AppServerFuzzyFileSearchController(client);
  const first = await controller.createSession({ roots: ["/repo"] });
  const second = await controller.createSession({ roots: ["/other"] });
  await first.update("one");
  await second.update("two");
  controller.dispose();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.filter(r => r.method === "fuzzyFileSearch/sessionStop").length, 2);
  const count = requests.length;
  await first.update("late");
  await second.stop();
  assert.equal(requests.length, count);
});

test("a search starting after disposal is stopped without sending its query", async () => {
  const requests: RecordedRequest[] = [];
  let acknowledge!: () => void;
  const pending = new Promise<void>(resolve => { acknowledge = resolve; });
  const { client } = createClient(async (method, params) => {
    requests.push({ method, params });
    if (method === "fuzzyFileSearch/sessionStart") await pending;
    return {};
  });
  const controller = new AppServerFuzzyFileSearchController(client);
  const session = await controller.createSession({ roots: ["/repo"] });
  const updating = session.update("file");
  await Promise.resolve();
  controller.dispose();
  acknowledge();
  await updating;
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(requests.map(r => r.method), [
    "fuzzyFileSearch/sessionStart", "fuzzyFileSearch/sessionStop",
  ]);
});

test("a transient index-start failure permits a later explicit query to retry", async () => {
  const requests: RecordedRequest[] = [];
  let failStart = true;
  const { client } = createClient(async (method, params) => {
    requests.push({ method, params });
    if (method === "fuzzyFileSearch/sessionStart" && failStart) {
      failStart = false;
      throw new Error("synthetic transport failure");
    }
    return {};
  });
  const controller = new AppServerFuzzyFileSearchController(client);
  const session = await controller.createSession({ roots: ["/repo"] });
  await assert.rejects(session.update("first"), /synthetic transport failure/u);
  await session.update("retry");
  assert.deepEqual(requests.map(request => request.method), [
    "fuzzyFileSearch/sessionStart", "fuzzyFileSearch/sessionStart", "fuzzyFileSearch/sessionUpdate",
  ]);
  await session.stop();
  controller.dispose();
});

test("clearing a query and replacing it do not publish stale session results", async () => {
  const { client, emit } = createClient(async () => ({}));
  const updates: string[] = [];
  let completed = 0;
  const controller = new AppServerFuzzyFileSearchController(client, { createSessionId: () => "query-owner" });
  const session = await controller.createSession({ roots: ["/repo"], onUpdated: update => updates.push(update.query), onCompleted: () => { completed++; } });
  await session.update("old");
  await session.update("");
  emit({ method: "fuzzyFileSearch/sessionUpdated", params: { sessionId: "query-owner", query: "old", files: [] } });
  emit({ method: "fuzzyFileSearch/sessionCompleted", params: { sessionId: "query-owner" } });
  assert.deepEqual(updates, []);
  assert.equal(completed, 0);
  await session.update("new");
  emit({ method: "fuzzyFileSearch/sessionUpdated", params: { sessionId: "query-owner", query: "old", files: [] } });
  emit({ method: "fuzzyFileSearch/sessionUpdated", params: { sessionId: "query-owner", query: "new", files: [] } });
  assert.deepEqual(updates, ["new"]);
  await session.stop();
  controller.dispose();
});

