import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DshExecutionAuthority } from "../apps/local-agent-host/src/dsh-execution-authority.js";
const owner = (id: string) => ({ connectionId: id, identity: { id: "local-user", username: "local" } });

test("connection and epoch fence admission, native start and stale completion", () => {
  const authority = new DshExecutionAuthority(":memory:");
  try {
    const a = owner("a"), b = owner("b");
    const first = authority.claim("t", a, "request-1");
    assert.throws(() => authority.claim("t", b, "request-2"), /lease/);
    assert.throws(() => authority.claim("t", a, "request-3"), /already/);
    assert.equal(authority.nativeStarted(first, "turn-1", "1"), true);
    assert.throws(() => authority.assertOwner("t", b), /authority/);
    assert.equal(authority.finish(first, "interrupted", "user"), true);
    const second = authority.claim("t", b, "request-4");
    assert.ok(second.epoch > first.epoch);
    assert.equal(authority.nativeStarted(first, "late-turn", "1"), false);
    assert.equal(authority.finish(first, "completed", "late"), false);
    assert.equal(authority.nativeStarted(second, "turn-2", "2"), true);
  } finally { authority.close(); }
});
test("new process boot fences old attempts and preserves monotonic epochs", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-admission-"));
  const path = join(root, "execution.sqlite");
  try {
    const first = new DshExecutionAuthority(path, "boot-a");
    const admitted = first.claim("t", owner("a"), "request");
    first.rememberInput(admitted, "native-token", "original-client-message");
    first.nativeStarted(admitted, "turn-1", "1");
    first.close();
    const second = new DshExecutionAuthority(path, "boot-b");
    try {
      assert.equal(second.recoveredOrphans.length, 1);
      assert.equal(second.recoveredOrphans[0].state, "orphaned");
      assert.equal(second.journal.nativeHistory("t").nativeStarts, 1);
      const input = { type: "user/message", seq: 1, time: 1, data: { source: { kind: "user", rpcId: "native-token" }, content: [] } };
      assert.equal((second.projectInput("t", input).data as any).source.rpcId, "original-client-message");
      assert.equal((second.projectInput("different-thread", input).data as any).source.rpcId, "native-token");
      const next = second.claim("t", owner("b"), "next");
      assert.ok(next.epoch > admitted.epoch);
    } finally { second.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("queue writes cannot bypass a running execution or a concurrent write lease", async () => {
  const authority = new DshExecutionAuthority(":memory:");
  try {
    const a = owner("a"), b = owner("b");
    const admission = authority.claim("t", a, "request");
    let writes = 0;
    await assert.rejects(authority.withWriteLease("t", b, async () => { writes++; }), /authority/);
    await authority.withWriteLease("t", a, async () => { writes++; });
    assert.equal(writes, 1);
    authority.finish(admission, "completed", "done");
    let release!: () => void;
    const waiting = authority.withWriteLease("t", a, () => new Promise<void>(resolve => { release = resolve; }));
    await assert.rejects(authority.withWriteLease("t", b, async () => {}), /lease/);
    release(); await waiting;
    await authority.withWriteLease("t", b, async () => { writes++; });
    assert.equal(writes, 2);
  } finally { authority.close(); }
});

test("only the same principal may reclaim an explicitly disconnected execution", () => {
  const authority = new DshExecutionAuthority(":memory:");
  try {
    const a = owner("a"), b = owner("b"), foreign = { connectionId: "foreign", identity: { id: "other", username: "other" } };
    const admitted = authority.claim("t", a, "request");
    authority.nativeStarted(admitted, "turn", "1");
    assert.equal(authority.reconnect("t", b), false, "a still-connected window cannot be displaced");
    authority.disconnect(a);
    assert.equal(authority.reconnect("t", foreign), false);
    assert.equal(authority.reconnect("t", b), true);
    assert.throws(() => authority.assertOwner("t", a), /authority/);
    assert.equal(authority.assertOwner("t", b).epoch, admitted.epoch);
    assert.equal(authority.table.get("t").state, "running");
  } finally { authority.close(); }
});

test("overlapping edits by one owner retain the lease until every edit settles", async () => {
  const authority = new DshExecutionAuthority(":memory:");
  try {
    const a = owner("a"), b = owner("b");
    let releaseFirst!: () => void, releaseSecond!: () => void;
    const first = authority.withWriteLease("t", a, () => new Promise<void>(resolve => { releaseFirst = resolve; }));
    const second = authority.withWriteLease("t", a, () => new Promise<void>(resolve => { releaseSecond = resolve; }));
    releaseFirst(); await first;
    await assert.rejects(authority.withWriteLease("t", b, async () => {}), /lease/);
    releaseSecond(); await second;
    await authority.withWriteLease("t", b, async () => {});
  } finally { authority.close(); }
});
