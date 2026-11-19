import assert from "node:assert/strict";
import test from "node:test";
import { SceneTransitionOwner, type SceneTransition } from "../../apps/workbench-web/src/components/scene-transition";

const target = { ownerId: "A", key: "primary-A", foreground: "primary" as const };
test("an obsolete caller cannot cancel another owners valid preparation", async () => {
  let presented: SceneTransition | null = null;
  const owner = new SceneTransitionOwner((scene) => {
    presented = scene;
  });
  const current = owner.begin(target, new AbortController().signal, () => true);
  const aborted = new AbortController();
  aborted.abort();
  const staleSignal = owner.begin(target, aborted.signal, () => true);
  const staleOwner = owner.begin({ ...target, ownerId: "old" }, new AbortController().signal, () => false);
  await assert.rejects(staleSignal.ready);
  await assert.rejects(staleOwner.ready);
  assert.equal(presented, current);
  assert.equal(current.signal.aborted, false);
  current.layoutReady();
  current.contentReady();
  await current.ready;
  assert.equal(
    current.commit(() => {}),
    true,
  );
});
test("a newer intent started by cancellation cleanup wins over the interrupted begin", async () => {
  let presented: SceneTransition | null = null;
  const owner = new SceneTransitionOwner((scene) => {
    presented = scene;
  });
  const old = owner.begin(target, new AbortController().signal, () => true);
  let newest!: SceneTransition;
  old.signal.addEventListener("abort", () => {
    newest = owner.begin({ ...target, key: "newest" }, new AbortController().signal, () => true);
  });
  const interrupted = owner.begin({ ...target, key: "interrupted" }, new AbortController().signal, () => true);
  assert.equal(presented, newest);
  assert.equal(interrupted.signal.aborted, true);
  await assert.rejects(interrupted.ready);
  newest.layoutReady();
  newest.contentReady();
  await newest.ready;
  assert.equal(
    newest.commit(() => {}),
    true,
  );
});

test("cancel during preparation publication prevents the interrupted acquisition", async () => {
  let presented: SceneTransition | null = null;
  let cancelOnRelease = false;
  const owner = new SceneTransitionOwner((scene) => {
    presented = scene;
    if (!scene && cancelOnRelease) owner.cancel();
  });
  owner.begin(target, new AbortController().signal, () => true);
  cancelOnRelease = true;
  const interrupted = owner.begin(target, new AbortController().signal, () => true);
  assert.equal(presented, null);
  assert.equal(interrupted.signal.aborted, true);
  await assert.rejects(interrupted.ready);
});

test("content readiness alone cannot hand off an unallocated primary scene", async () => {
  const owner = new SceneTransitionOwner(() => {});
  const lease = owner.begin(target, new AbortController().signal, () => true);
  let ready = false;
  void lease.ready.then(() => {
    ready = true;
  });
  lease.contentReady();
  await Promise.resolve();
  assert.equal(ready, false);
  lease.layoutReady();
  await lease.ready;
  assert.equal(ready, true);
  let commits = 0;
  assert.equal(
    lease.commit(() => commits++),
    true,
  );
  assert.equal(
    lease.commit(() => commits++),
    false,
  );
  assert.equal(commits, 1);
});
test("owner replacement after readiness revokes the late selection commit", async () => {
  let epoch = 1,
    commits = 0;
  const owner = new SceneTransitionOwner(() => {});
  const lease = owner.begin(target, new AbortController().signal, () => epoch === 1);
  lease.layoutReady();
  lease.contentReady();
  await lease.ready;
  epoch++;
  assert.equal(
    lease.commit(() => commits++),
    false,
  );
  assert.equal(commits, 0);
  assert.equal(lease.signal.aborted, true);
});
test("superseded preparation and late cleanup cannot revoke the next lease", async () => {
  let presented: SceneTransition | null = null;
  const owner = new SceneTransitionOwner((scene) => {
    presented = scene;
  });
  const old = owner.begin(target, new AbortController().signal, () => true);
  const next = owner.begin(
    { ...target, key: "browser-B", foreground: "tools" },
    new AbortController().signal,
    () => true,
  );
  old.layoutReady();
  old.contentReady();
  old.cancel();
  await assert.rejects(old.ready);
  assert.equal(presented, next);
  assert.equal(next.signal.aborted, false);
  next.layoutReady();
  next.contentReady();
  await next.ready;
  assert.equal(
    old.commit(() => assert.fail("stale commit")),
    false,
  );
  assert.equal(presented, next);
});
test("physical handback abort keeps the allocation leased until selection is committed", async () => {
  let presented: SceneTransition | null = null;
  const owner = new SceneTransitionOwner((scene) => {
    presented = scene;
  });
  const parent = new AbortController();
  const lease = owner.begin(target, parent.signal, () => true);
  lease.layoutReady();
  lease.contentReady();
  await lease.ready;
  assert.equal(
    lease.commit(() => {
      parent.abort();
      owner.cancel();
      assert.equal(presented, lease, "no rollback allocation between cleanup and selection");
    }),
    true,
  );
  assert.equal(presented, null);
});
test("cancellation remains observable after ready has already resolved", async () => {
  const owner = new SceneTransitionOwner(() => {});
  const parent = new AbortController();
  const lease = owner.begin(target, parent.signal, () => true);
  lease.layoutReady();
  lease.contentReady();
  await lease.ready;
  parent.abort();
  assert.equal(lease.signal.aborted, true);
  assert.equal(
    lease.commit(() => assert.fail("cancelled commit")),
    false,
  );
});

test("missing renderer readiness and pre-aborted preparation never acquire selection", async () => {
  let presented: SceneTransition | null = null;
  const owner = new SceneTransitionOwner((scene) => {
    presented = scene;
  });
  const parent = new AbortController();
  parent.abort();
  const cancelled = owner.begin(target, parent.signal, () => true);
  await assert.rejects(cancelled.ready);
  assert.equal(presented, null);
  const waiting = owner.begin({ ...target, foreground: "tools" }, new AbortController().signal, () => true);
  waiting.layoutReady();
  let ready = false;
  void waiting.ready.then(
    () => {
      ready = true;
    },
    () => {},
  );
  await Promise.resolve();
  assert.equal(ready, false);
  waiting.unavailable();
  await assert.rejects(waiting.ready);
  assert.equal(presented, null);
  assert.equal(
    waiting.commit(() => assert.fail("unavailable target")),
    false,
  );
});

test("a throwing handoff releases allocation and cannot be retried", async () => {
  let presented: SceneTransition | null = null;
  const owner = new SceneTransitionOwner((scene) => {
    presented = scene;
  });
  const lease = owner.begin(target, new AbortController().signal, () => true);
  lease.layoutReady();
  lease.contentReady();
  await lease.ready;
  assert.throws(
    () =>
      lease.commit(() => {
        throw Error("renderer detached");
      }),
    /renderer detached/,
  );
  assert.equal(presented, null);
  assert.equal(lease.signal.aborted, true);
  assert.equal(
    lease.commit(() => assert.fail("retry")),
    false,
  );
});

test("home layout invalidates the same ready lease and stops on release", async () => {
  const owner = new SceneTransitionOwner(() => {});
  const scene = owner.begin(
    { ownerId: "owner", key: "tool", foreground: "tools" },
    new AbortController().signal,
    () => true,
  );
  let changes = 0;
  const stop = scene.subscribeLayout(() => changes++);
  scene.layoutReady();
  scene.contentReady();
  await scene.ready;
  scene.layoutReady(); // Renderer/dock allocation changed, not a new scene.
  assert.equal(changes, 2);
  stop();
  scene.layoutReady();
  assert.equal(changes, 2);
  scene.subscribeLayout(() => changes++);
  assert.equal(
    scene.commit(() => {}),
    true,
  );
  scene.layoutReady();
  assert.equal(changes, 2, "committed lease cannot rebase a later flight");
  const cancelled = owner.begin(
    { ownerId: "owner", key: "next", foreground: "primary" },
    new AbortController().signal,
    () => true,
  );
  cancelled.subscribeLayout(() => changes++);
  cancelled.cancel();
  cancelled.layoutReady();
  assert.equal(changes, 2, "cancelled lease cannot publish stale layout");
});

test("a stale ready owner cannot publish new layout", async () => {
  let current = true,
    changes = 0;
  const owner = new SceneTransitionOwner(() => {});
  const scene = owner.begin(
    { ownerId: "owner", key: "tool", foreground: "tools" },
    new AbortController().signal,
    () => current,
  );
  scene.layoutReady();
  scene.contentReady();
  await scene.ready;
  scene.subscribeLayout(() => changes++);
  current = false;
  scene.layoutReady();
  assert.equal(changes, 0);
  assert.equal(scene.signal.aborted, true);
});
