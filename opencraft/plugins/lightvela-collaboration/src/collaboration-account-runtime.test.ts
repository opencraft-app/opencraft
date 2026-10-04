import assert from "node:assert/strict";
import test from "node:test";
import { CollaborationAccountRuntime } from "./collaboration-account-runtime";
import { CollaborationMessagingService } from "./collaboration-messaging-service";

test("account authority changes discard the old scope and fence the next IM connection", async () => {
  let epoch = 0;
  const listeners = new Set<() => void>();
  let finishLogout!: () => void;
  const logout = new Promise<void>((resolve) => { finishLogout = resolve; });
  const scopes: Array<{
    authGeneration: number;
    beforeConnect: Promise<void>;
    invalidated: boolean;
    disposals: number;
    invalidate(): void;
    dispose(): Promise<void>;
  }> = [];
  const runtime = new CollaborationAccountRuntime({
    getSnapshot: () => ({ authGeneration: epoch }),
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  }, ({ authGeneration, beforeConnect }) => {
    const scope = {
      authGeneration, beforeConnect, invalidated: false, disposals: 0,
      invalidate() { this.invalidated = true; },
      async dispose() { this.disposals += 1; if (authGeneration === 0) await logout; },
    };
    scopes.push(scope);
    return scope;
  });
  runtime.start();
  const original = runtime.getSnapshot().scope;
  for (const listener of listeners) listener();
  assert.equal(runtime.getSnapshot().scope, original);
  epoch = 1;
  for (const listener of listeners) listener();
  assert.equal(original.invalidated, true);
  assert.equal(original.disposals, 1);
  assert.notEqual(runtime.getSnapshot().scope, original);
  let nextCanConnect = false;
  const nextConnection = runtime.getSnapshot().scope.beforeConnect.then(() => { nextCanConnect = true; });
  await Promise.resolve();
  assert.equal(nextCanConnect, false);
  finishLogout();
  await nextConnection;
  assert.equal(nextCanConnect, true);
  await runtime.dispose();
  await runtime.dispose();
  assert.equal(listeners.size, 0);
  assert.equal(scopes[1]?.disposals, 1);
});

test("rapid account changes skip a superseded IM login and wait for the old owner logout", async () => {
  let epoch = 0;
  let notify: () => void = () => {};
  let finishLogout!: () => void;
  const logout = new Promise<void>((resolve) => { finishLogout = resolve; });
  const events: string[] = [];
  let closes = 0;
  const gateway = {
    connect: async (session: { userId: string }) => { events.push("login:" + session.userId); },
    close: async () => { events.push("logout"); if (++closes === 1) await logout; },
  };
  const runtime = new CollaborationAccountRuntime({
    getSnapshot: () => ({ authGeneration: epoch }),
    subscribe: (listener) => { notify = listener; return () => { notify = () => {}; }; },
  }, ({ authGeneration, beforeConnect }) => {
    const messaging = new CollaborationMessagingService({
      createHumanImSession: async () => ({
        sdkAppId: 1, userId: "human-" + authGeneration,
        userSig: "test-user-sig", expiresAt: "2026-10-04T12:00:00Z",
      }),
    }, gateway, beforeConnect);
    return { messaging, invalidate() {}, dispose: () => messaging.dispose() };
  });
  runtime.start();
  await runtime.getSnapshot().scope.messaging.connect();
  epoch = 1;
  notify();
  const superseded = runtime.getSnapshot().scope.messaging.connect();
  epoch = 2;
  notify();
  const next = runtime.getSnapshot().scope.messaging.connect();
  await Promise.resolve();
  await Promise.resolve();
  assert.ok(!events.includes("login:human-1"));
  finishLogout();
  await Promise.all([superseded, next]);
  assert.deepEqual(events, ["login:human-0", "logout", "logout", "login:human-2"]);
  await runtime.dispose();
});
