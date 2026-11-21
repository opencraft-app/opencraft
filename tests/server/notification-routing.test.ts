import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openPushStore, TurnPushService, type PushBinding } from "@opencraft/web-push-node";
import { createWorkbenchWebServer } from "../../apps/headless-server/src/serve-workbench-web.mjs";

const messages = { completed: "Done", failed: "Failed", interrupted: "Stopped", body: "Return", test: "Test" };

test("workbench routes the destination API through the authenticated real push owner", async () => {
  const root = await mkdtemp(join(tmpdir(), "notification-route-"));
  const binding: PushBinding = {
    context: { actorId: "human-a", credentialId: null, generation: 1, expiresAt: Date.now() + 60_000 },
  };
  let authenticated = false;
  const store = await openPushStore(join(root, "push.sqlite"));
  const push = new TurnPushService(store, {
    authenticate: () => (authenticated ? binding : null),
    current: () => true,
    trustedOrigin: () => null,
    hosts: [],
    read: async () => ({}),
    sendExternal: async () => {},
  });
  const server = await createWorkbenchWebServer({ root, appServerTarget: null, turnPushService: push });
  try {
    const base = `http://127.0.0.1:${(await server.listen({ host: "127.0.0.1", port: 0 })).port}`;
    assert.equal((await fetch(base + "/__opencraft_notifications")).status, 401);
    authenticated = true;
    const config = await fetch(base + "/__opencraft_notifications");
    assert.equal(config.status, 200);
    assert.equal((await config.json()).actorId, "human-a");
    const saved = await fetch(base + "/__opencraft_notifications", {
      method: "POST",
      headers: { origin: base, "content-type": "application/json" },
      body: JSON.stringify({
        operation: "save",
        expectedActorId: "human-a",
        target: { kind: "webhook", url: "https://receiver.example/endpoint", authorization: "private-token" },
        locale: "en-US",
        messages,
      }),
    });
    assert.equal(saved.status, 200);
    const body = await saved.text();
    assert.doesNotMatch(body, /private-token|receiver\.example\/endpoint/);
    assert.equal(JSON.parse(body).destinations.length, 1);
    const forbidden = await fetch(base + "/__opencraft_notifications", {
      method: "POST",
      headers: { origin: "https://attacker.example", "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(forbidden.status, 403);
    assert.equal((await fetch(base + "/__opencraft_notifications-extra")).status, 404);
  } finally {
    await server.close();
    await push.close();
    await rm(root, { recursive: true, force: true });
  }
});
