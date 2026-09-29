import assert from "node:assert/strict";
import test from "node:test";

import { AppServerClientError } from "@opencraft/appserver-client";
import { forkAndOpenThread } from "../apps/workbench-web/src/runtime/thread-fork-navigation.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test("acknowledged fork opens without waiting for catalog refresh", async () => {
  const refresh = deferred<void>();
  const opened: string[] = [];
  await forkAndOpenThread({
    routeScopeId: () => "parent-route",
    fork: async () => "child-thread",
    refreshThreads: () => refresh.promise,
    openThread: async id => { opened.push(id); },
  });
  assert.deepEqual(opened, ["child-thread"]);
  refresh.resolve();
});

test("fork does not steal navigation after the route changes", async () => {
  const fork = deferred<string>();
  let routeScopeId = "parent-route";
  let refreshes = 0;
  const opened: string[] = [];
  const operation = forkAndOpenThread({
    routeScopeId: () => routeScopeId,
    fork: () => fork.promise,
    refreshThreads: async () => { refreshes += 1; },
    openThread: async id => { opened.push(id); },
  });
  routeScopeId = "another-route";
  fork.resolve("child-thread");
  await operation;
  assert.equal(refreshes, 1);
  assert.deepEqual(opened, []);
});

test("refresh failure does not hide an acknowledged fork", async () => {
  const opened: string[] = [];
  await forkAndOpenThread({
    routeScopeId: () => "parent-route",
    fork: async () => "child-thread",
    refreshThreads: async () => { throw new Error("catalog temporarily unavailable"); },
    openThread: async id => { opened.push(id); },
  });
  assert.deepEqual(opened, ["child-thread"]);
});

test("failed fork never refreshes or navigates", async () => {
  let refreshes = 0;
  let opens = 0;
  await assert.rejects(forkAndOpenThread({
    routeScopeId: () => "parent-route",
    fork: async () => { throw new Error("fork rejected"); },
    refreshThreads: async () => { refreshes += 1; },
    openThread: async () => { opens += 1; },
  }), /fork rejected/u);
  assert.equal(refreshes, 0);
  assert.equal(opens, 0);
});

test("transport loss preserves an unknown fork outcome and never retries", async () => {
  let attempts = 0;
  let opens = 0;
  await assert.rejects(forkAndOpenThread({
    routeScopeId: () => "parent-route",
    fork: async () => { attempts += 1; throw new AppServerClientError("TRANSPORT_ERROR", "link lost"); },
    refreshThreads: async () => { throw new Error("must not refresh"); },
    openThread: async () => { opens += 1; },
  }), /可能已经创建/u);
  assert.equal(attempts, 1);
  assert.equal(opens, 0);
});
