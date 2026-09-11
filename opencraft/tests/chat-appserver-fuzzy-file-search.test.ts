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

test("fuzzy file search keeps one Codex session across query updates", async () => {
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
