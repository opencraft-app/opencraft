import assert from "node:assert/strict";
import test from "node:test";
import {
  TASKS,
  type TasksRequestPort,
  type TasksSnapshot,
} from "@opencraft/appserver-protocol";
import { TasksController } from "../plugins/tasks/src/controller";
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
