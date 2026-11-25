import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { APP_HOST_CLIENT_INSTANCE_PARAMETER } from "@opencraft/app-host-protocol/routing";
import { memoryStateDocumentStore } from "@opencraft/document-storage/state";
import {
  THREAD_PLACEMENT_LOOKUP_PATH,
  THREAD_PLACEMENT_PUBLISH_PATH,
  ThreadPlacementProjection,
  type ThreadPlacementReceipt,
} from "../../apps/headless-server/src/cloudflare/thread-placement.ts";
import { miniflareRuntime } from "../cloudflare/miniflare-runtime.ts";
import type { WorkerSpec } from "../cloudflare/worker-runtime.ts";
import {
  LOCAL_ORIGIN,
  PROOF,
  login,
  type Backend,
  type Browser,
} from "../storage/workerd/installation-core-do.scenarios.ts";

const spec: WorkerSpec = {
  id: "thread-placement",
  entry: resolve(import.meta.dirname, "workerd/thread-placement-worker.ts"),
  compatibilityFlags: ["nodejs_compat"],
  durableObjects: {
    INSTALLATION_CORE: "TestPlacementInstallation",
    ACCOUNT_CORE: "AccountCore",
    TEST_WORKSPACE_RECEIPTS: "PlacementFixture",
  },
  externalNode: true,
};
const receipt: ThreadPlacementReceipt = {
  serverId: "server:installation:codex",
  threadId: "native-thread",
  workspaceId: "user-workspace",
  revision: 1,
  state: "placed",
};
const thread = { serverId: receipt.serverId, threadId: receipt.threadId };

test(
  "Thread placement admission requires a committed owner receipt and current Thread and client access",
  { timeout: 25_000 },
  async (t) => {
    const runtime = miniflareRuntime();
    t.after(() => runtime.dispose());
    const start = (enabled: boolean) =>
      runtime.start(spec, {
        persist: "thread-placement",
        localOrigin: LOCAL_ORIGIN,
        vars: {
          OPENCRAFT_HUMAN_AUTH: JSON.stringify({ origin: LOCAL_ORIGIN, local: true, oidc: [] }),
          OPENCRAFT_SETUP_TOKEN: PROOF,
          TEST_ENABLE_PLACEMENT: String(enabled),
        },
      });
    let worker = await start(false);
    const backend: Backend = {
      origin: LOCAL_ORIGIN,
      fetch: (path, init) => worker.fetch(LOCAL_ORIGIN + path, init),
      async restart() {
        await runtime.stop(worker);
        worker = await start(true);
      },
      close: () => runtime.stop(worker),
    };
    const { owner, member, memberId } = await login(backend);
    const attach = async (browser: Browser) => {
      const result = await browser.call(
        `/__test/admission?${APP_HOST_CLIENT_INSTANCE_PARAMETER}=attachment-fixture`,
        undefined,
        { origin: LOCAL_ORIGIN },
      );
      assert.equal(result.status, 200);
      return result.json();
    };
    const ownerAttachment = await attach(owner);
    const memberAttachment = await attach(member);
    const commit = (value: ThreadPlacementReceipt) => owner.call("/__test/commit", value);
    const publish = (value: ThreadPlacementReceipt) => owner.call("/__test/publish", value);
    const lookup = (attachment: unknown, key = thread) => owner.call("/__test/lookup", { thread: key, attachment });

    assert.equal((await publish(receipt)).status, 404, "default installation does not activate placement");
    assert.equal((await lookup(ownerAttachment)).status, 404);
    await backend.restart();
    assert.equal((await owner.call(THREAD_PLACEMENT_LOOKUP_PATH, { thread, attachment: ownerAttachment })).status, 404);
    assert.equal((await owner.call(THREAD_PLACEMENT_PUBLISH_PATH, receipt)).status, 404);
    assert.equal(
      (await lookup(ownerAttachment)).status,
      404,
      "current Thread policy's default shared does not prove existence",
    );
    assert.equal((await publish(receipt)).status, 409, "a workspace hint alone proves no placement");
    assert.equal((await commit(receipt)).status, 204);
    assert.equal(
      (await publish({ ...receipt, workspaceId: "other-workspace" })).status,
      409,
      "the wrong bound owner cannot confirm",
    );
    assert.equal((await publish(receipt)).status, 204);
    assert.equal((await publish(receipt)).status, 204, "safe duplicate delivery");
    assert.deepEqual(await (await lookup(ownerAttachment)).json(), receipt);
    assert.equal((await lookup(ownerAttachment, { ...thread, serverId: "server:other:codex" })).status, 404);
    assert.equal((await lookup(memberAttachment)).status, 200);
    assert.equal((await owner.call("/__test/private-thread", { thread, attachment: ownerAttachment })).status, 204);
    assert.equal((await lookup(memberAttachment)).status, 404, "Thread owner's private policy applies");
    assert.equal((await lookup(ownerAttachment)).status, 200);
    await backend.restart();
    assert.deepEqual(
      await (await lookup(ownerAttachment)).json(),
      receipt,
      "both owners persisted their committed state",
    );
    assert.equal((await lookup(memberAttachment)).status, 404, "Thread policy persisted");

    const foreign = { ...receipt, workspaceId: "other-workspace", revision: 2 };
    assert.equal((await commit(foreign)).status, 204);
    assert.equal((await publish(foreign)).status, 409, "ordinary publication cannot transfer the Thread");
    const removed = { ...receipt, revision: 2, state: "removed" } as const;
    assert.equal((await commit(removed)).status, 204);
    assert.equal((await lookup(ownerAttachment)).status, 404, "a stale projection cannot outlive source removal");
    assert.equal((await publish(removed)).status, 204);
    await backend.restart();
    assert.equal((await lookup(ownerAttachment)).status, 404);
    assert.equal((await publish(receipt)).status, 409, "old positive receipt cannot revive a removed Thread");
    assert.equal((await publish(foreign)).status, 409, "the workspace fence survives a tombstone and restart");

    const restored = { ...receipt, revision: 3 };
    assert.equal((await commit(restored)).status, 204);
    assert.equal((await publish(restored)).status, 204);
    assert.deepEqual(await (await lookup(ownerAttachment)).json(), restored);
    assert.equal(
      (await owner.call("/__opencraft_access/members", { actorId: memberId, role: "member", enabled: false })).status,
      200,
    );
    assert.equal((await lookup(memberAttachment)).status, 403);
    assert.equal((await owner.call("/__opencraft_auth/logout", {})).status, 200);
    assert.equal((await lookup(ownerAttachment)).status, 401);
  },
);

test("late confirmations cannot regress publication or authorize a stale positive lookup", async () => {
  const later = { ...receipt, revision: 2, state: "removed" } as const;
  let committed: ThreadPlacementReceipt = receipt;
  let pause: { observed(): void; release: Promise<void> } | undefined;
  const projection = new ThreadPlacementProjection(memoryStateDocumentStore(), {
    workspace: () => ({
      async readCommitted() {
        const answer = committed;
        if (pause) {
          const gate = pause;
          pause = undefined;
          gate.observed();
          await gate.release;
        }
        return answer;
      },
    }),
    allows: () => true,
  });
  async function deferConfirmation<T>(operation: () => Promise<T>) {
    const observed = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    pause = { observed: observed.resolve, release: finish.promise };
    const pending = operation();
    await observed.promise;
    return { finish: finish.resolve, pending };
  }

  assert.equal(await projection.publish(receipt), "applied");
  const lookup = await deferConfirmation(() => projection.lookup(thread));
  const publication = await deferConfirmation(() => projection.publish(receipt));
  committed = later;
  assert.equal(await projection.publish(later), "applied");
  lookup.finish();
  publication.finish();
  assert.equal(await lookup.pending, null);
  assert.equal(await publication.pending, "conflict");
  assert.equal(await projection.lookup(thread), null);
});
