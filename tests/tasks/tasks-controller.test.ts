import assert from "node:assert/strict";
import test from "node:test";
import {
  TASKS,
  type TasksRequestPort,
  type TasksSnapshot,
} from "@opencraft/appserver-protocol";
import { TasksController } from "../../plugins/tasks/src/controller";
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function port(
  request: (method: string, params: unknown) => Promise<unknown>,
): TasksRequestPort {
  return { request } as TasksRequestPort;
}
const empty: TasksSnapshot = { tasks: [] };
const create = {
  id: "a",
  title: "Task",
  description: "",
  status: "todo" as const,
  projectId: null,
  projectServerId: null,
};
const saved: TasksSnapshot = {
  tasks: [
    {
      ...create,
      revision: 1,
      sortOrder: 0,
      createdAt: 1,
      updatedAt: 1,
      deletedAt: null,
      conversations: [],
    },
  ],
};
test("late reads cannot erase committed tasks and overlapping full-snapshot writes are serialized", async () => {
  const stale = deferred<TasksSnapshot>(),
    write = deferred<TasksSnapshot>();
  let reads = 0,
    writes = 0;
  const model = new TasksController(
    port(async (method) =>
      method === TASKS.capabilities
        ? { version: 1, storage: "sqlite-rows" }
        : method === TASKS.list
          ? ++reads === 1
            ? empty
            : stale.promise
          : (++writes, write.promise),
    ),
  );
  await model.start();
  const refresh = model.refresh(),
    mutation = model.mutate(TASKS.create, create);
  assert.equal(await model.mutate(TASKS.create, { ...create, id: "b" }), false);
  assert.equal(writes, 1);
  write.resolve(saved);
  assert.equal(await mutation, true);
  stale.resolve(empty);
  await refresh;
  assert.equal(model.getSnapshot().tasks[0].id, "a");
  model.dispose();
});
test("a lost acknowledgement re-reads authority without replaying and preserves an error for review", async () => {
  let writes = 0,
    committed = false;
  const model = new TasksController(
    port(async (method) => {
      if (method === TASKS.capabilities)
        return { version: 1, storage: "sqlite-rows" };
      if (method === TASKS.list) return committed ? saved : empty;
      writes++;
      committed = true;
      throw new Error("lost reply");
    }),
  );
  await model.start();
  assert.equal(await model.mutate(TASKS.create, create), false);
  assert.equal(writes, 1);
  assert.equal(model.getSnapshot().tasks[0].id, "a");
  assert.equal(model.getSnapshot().error, "save");
  model.dispose();
});
test("notifications during writes queue a refresh and disposal fences late replies", async () => {
  const write = deferred<TasksSnapshot>();
  let reads = 0;
  const model = new TasksController(
    port(async (method) =>
      method === TASKS.capabilities
        ? { version: 1, storage: "sqlite-rows" }
        : method === TASKS.list
          ? (reads++, empty)
          : write.promise,
    ),
  );
  await model.start();
  const mutation = model.mutate(TASKS.create, create);
  await model.refresh();
  write.resolve(saved);
  await mutation;
  assert.equal(reads, 2);
  const late = deferred<TasksSnapshot>();
  const other = new TasksController(
    port(async (method) =>
      method === TASKS.capabilities
        ? { version: 1, storage: "sqlite-rows" }
        : late.promise,
    ),
  );
  const starting = other.start();
  await Promise.resolve();
  other.dispose();
  late.resolve(saved);
  await starting;
  assert.equal(other.getSnapshot().tasks.length, 0);
  model.dispose();
});

test("recycle capability and a lost restore acknowledgement reconcile from authority without replay", async () => {
  const deleted = { ...saved.tasks[0], deletedAt: 100, revision: 2 };
  let committed = false, writes = 0;
  const model = new TasksController(port(async method => {
    if (method === TASKS.capabilities) return { version: 1, storage: "sqlite-rows", recycleBinRetentionMs: 604800000 };
    if (method === TASKS.list) return committed ? { ...saved, recycled: [] } : { tasks: [], recycled: [deleted] };
    assert.equal(method, TASKS.restore); writes++; committed = true; throw new Error("lost acknowledgement");
  }));
  await model.start();
  assert.equal(model.getSnapshot().recycleBinRetentionMs,604800000);
  assert.equal(model.getSnapshot().recycled[0].id,"a");
  assert.equal(await model.mutate(TASKS.restore,{id:"a",expectedRevision:2}),false);
  assert.equal(writes,1); assert.equal(model.getSnapshot().recycled.length,0);
  assert.equal(model.getSnapshot().tasks[0].id,"a"); assert.equal(model.getSnapshot().error,"restore");
  model.dispose();
});

test("older authorities leave the recycle feature unavailable while keeping ordinary tasks", async () => {
  const model = new TasksController(port(async method => method === TASKS.capabilities ? {version:1,storage:"sqlite-rows"} : saved));
  await model.start(); assert.equal(model.getSnapshot().recycleBinRetentionMs,null);
  assert.deepEqual(model.getSnapshot().recycled,[]); assert.equal(model.getSnapshot().tasks[0].id,"a"); model.dispose();
});

test("explicit refresh discovers a separately upgraded authority without writing unsupported planning fields", async () => {
  let upgraded = false;
  const model = new TasksController(port(async method => method === TASKS.capabilities
    ? { version: 1, storage: "sqlite-rows", ...(upgraded ? { planning: true, supportedKinds: ["harness"], activity: true, progress: true } : {}) }
    : empty));
  await model.start(); assert.equal(model.getSnapshot().planning, false); assert.equal(model.getSnapshot().activity, false);
  upgraded = true; await model.start(); assert.equal(model.getSnapshot().planning, true); assert.deepEqual(model.getSnapshot().supportedKinds, ["harness"]); model.dispose();
});


test("cold loading lasts through capabilities and list; failure is not an empty success and retry waits", async () => {
  const capabilities = deferred<unknown>(), first = deferred<TasksSnapshot>(), retry = deferred<TasksSnapshot>(), reading = deferred<void>();
  let reads = 0;
  const model = new TasksController(port(async method => method === TASKS.capabilities ? capabilities.promise : (reading.resolve(), ++reads === 1 ? first.promise : retry.promise)));
  assert.equal(model.getSnapshot().phase, "loading");
  const starting = model.start();
  assert.equal(model.getSnapshot().phase, "loading");
  capabilities.resolve({ version: 1, storage: "sqlite-rows" });
  await reading.promise;
  assert.equal(reads, 1);
  assert.equal(model.getSnapshot().phase, "loading", "Capabilities do not constitute loaded data");
  first.reject(new Error("offline")); await starting;
  assert.equal(model.getSnapshot().phase, "error");
  assert.equal(model.getSnapshot().error, null, "Cold error is shown in the content region, without a cached-data notice");
  const retrying = model.refresh();
  assert.equal(model.getSnapshot().phase, "loading");
  retry.resolve(saved); await retrying;
  assert.equal(model.getSnapshot().phase, "ready");
  assert.equal(model.getSnapshot().tasks[0].id, "a"); model.dispose();
});

test("a successful empty snapshot is ready and survives a failed background refresh", async () => {
  let offline = false;
  const model = new TasksController(port(async method => {
    if (method === TASKS.capabilities) return { version: 1, storage: "sqlite-rows" };
    if (offline) throw new Error("offline");
    return empty;
  }));
  await model.start(); assert.equal(model.getSnapshot().phase, "ready");
  const tasks = model.getSnapshot().tasks;
  offline = true; await model.refresh();
  assert.equal(model.getSnapshot().phase, "ready");
  assert.equal(model.getSnapshot().tasks, tasks); assert.equal(model.getSnapshot().error, "refresh"); model.dispose();
});

test("cached tasks retain identity throughout a held or failed explicit refresh, and re-entry", async () => {
  const read = deferred<TasksSnapshot>(); let reads = 0, offline = false;
  const model = new TasksController(port(async method => {
    if (method === TASKS.capabilities) { if (offline) throw new Error("offline"); return { version: 1, storage: "sqlite-rows" }; }
    return ++reads === 1 ? saved : read.promise;
  }));
  await model.start(); const tasks = model.getSnapshot().tasks;
  const refreshing = model.start(); await Promise.resolve(); await Promise.resolve();
  assert.equal(model.getSnapshot().phase, "ready"); assert.equal(model.getSnapshot().tasks, tasks);
  read.reject(new Error("offline")); await refreshing;
  assert.equal(model.getSnapshot().phase, "ready"); assert.equal(model.getSnapshot().tasks, tasks);
  assert.equal(model.getSnapshot().error, "refresh");
  offline = true; await model.start();
  assert.equal(model.getSnapshot().phase, "ready"); assert.equal(model.getSnapshot().tasks, tasks);
  model.dispose();
});

test("capability failure offers unavailable state; explicit retry can load a real empty board", async () => {
  let offline = true;
  const model = new TasksController(port(async method => {
    if (offline) throw new Error("offline");
    return method === TASKS.capabilities ? { version: 1, storage: "sqlite-rows" } : empty;
  }));
  await model.start(); assert.equal(model.getSnapshot().phase, "unavailable");
  offline = false; await model.start(); assert.equal(model.getSnapshot().phase, "ready"); model.dispose();
});
