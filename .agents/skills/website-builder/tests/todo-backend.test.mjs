// Offline template regressions only: this adapter is not native persistence acceptance.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import app from "../templates/todo-backend.mjs";

const templateURL = new URL("../templates/todo-backend.mjs", import.meta.url);
const legacySchema = "CREATE TABLE todos (id TEXT PRIMARY KEY, title TEXT NOT NULL, done INTEGER NOT NULL CHECK(done IN (0, 1)), created_at INTEGER NOT NULL)";
const uuid = (n) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

function storage(t, { legacy = false, beforeExec } = {}) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  if (legacy) db.exec(legacySchema);
  const state = { db, calls: [], readOnly: false };
  state.env = {
    RIVET_STORAGE: {
      sql: {
        async exec(statement, params = []) {
          state.calls.push({ statement, params });
          if (state.readOnly) assert.match(statement, /^\s*SELECT\b/i, "viewer reads must not initialize or mutate storage");
          if (beforeExec) await beforeExec(statement, params);
          return { rows: db.prepare(statement).all(...params) };
        },
      },
    },
  };
  state.onlyRead = () => {
    state.readOnly = true;
    db.exec("PRAGMA query_only = ON");
  };
  return state;
}

async function request(state, method, body, handler = app) {
  const response = await handler.fetch(new Request("https://offline.invalid/api/todos", {
    method,
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  }), state.env);
  return { status: response.status, body: await response.json() };
}

function seed(state, count) {
  const insert = state.db.prepare("INSERT INTO todos (id, title, done, created_at) VALUES (?, ?, ?, ?)");
  for (let n = 1; n <= count; n++) insert.run(uuid(n), `seed ${n}`, n % 2, n);
}

function rendezvous(parties) {
  let arrived = 0;
  let release;
  const ready = new Promise((resolve) => { release = resolve; });
  return async () => {
    if (++arrived === parties) release();
    await ready;
  };
}

function beforeTodoInsert(parties) {
  const meet = rendezvous(parties);
  return async (statement) => {
    if (/^\s*INSERT\s+INTO\s+todos\b/i.test(statement)) await meet();
  };
}

function snapshot(state) {
  return state.db.prepare("SELECT id, title, done, created_at FROM todos ORDER BY id").all();
}

test("DELETE keeps a tombstone: an ambiguous POST retry cannot resurrect a Todo", async (t) => {
  const state = storage(t);
  const body = { id: uuid(1), title: "one intent" };
  assert.equal((await request(state, "POST", body)).status, 201);
  assert.equal((await request(state, "DELETE", { id: body.id })).status, 200);
  assert.equal((await request(state, "DELETE", { id: body.id })).status, 200);
  assert.equal((await request(state, "POST", body)).status, 409);
  assert.equal((await request(state, "POST", { ...body, title: "another intent" })).status, 409);
  assert.deepEqual((await request(state, "GET")).body, { todos: [] });
});

test("DELETE before delayed creation also reserves the UUID", async (t) => {
  const state = storage(t);
  assert.equal((await request(state, "DELETE", { id: uuid(1) })).status, 200);
  assert.equal((await request(state, "POST", { id: uuid(1), title: "delayed" })).status, 409);
  assert.deepEqual((await request(state, "GET")).body, { todos: [] });
});

test("PATCH cannot make a deleted Todo visible", async (t) => {
  const state = storage(t);
  await request(state, "POST", { id: uuid(1), title: "deleted" });
  await request(state, "DELETE", { id: uuid(1) });
  assert.equal((await request(state, "PATCH", { id: uuid(1), done: true })).status, 200);
  assert.deepEqual((await request(state, "GET")).body, { todos: [] });
  assert.equal((await request(state, "POST", { id: uuid(1), title: "deleted" })).status, 409);
});

test("concurrent same UUID with different titles rechecks the winning intent", { timeout: 3000 }, async (t) => {
  const state = storage(t, { legacy: true, beforeExec: beforeTodoInsert(2) });
  const titles = ["intent A", "intent B"];
  const replies = await Promise.all(titles.map((title) => request(state, "POST", { id: uuid(1), title })));
  assert.deepEqual(replies.map((r) => r.status).sort(), [201, 409]);
  for (let i = 0; i < replies.length; i++) {
    if (replies[i].status === 201) assert.equal(replies[i].body.todo.title, titles[i]);
  }
  assert.equal(snapshot(state).length, 1);
});

test("the final POST read rejects a DELETE completed after insertion", { timeout: 3000 }, async (t) => {
  let inserted;
  let resume;
  const atFinalRead = new Promise((resolve) => { inserted = resolve; });
  const continueRead = new Promise((resolve) => { resume = resolve; });
  const state = storage(t, {
    beforeExec: async (statement) => {
      if (statement.includes("LEFT JOIN todos AS todo")) {
        inserted();
        await continueRead;
      }
    },
  });
  const pending = request(state, "POST", { id: uuid(1), title: "in flight" });
  await atFinalRead;
  try {
    assert.equal((await request(state, "DELETE", { id: uuid(1) })).status, 200);
  } finally {
    resume();
  }
  assert.equal((await pending).status, 409);
  assert.deepEqual((await request(state, "GET")).body, { todos: [] });
});

test("a DELETE completed before a concurrent INSERT cannot be undone", { timeout: 3000 }, async (t) => {
  let reached;
  let resume;
  const atInsert = new Promise((resolve) => { reached = resolve; });
  const continueInsert = new Promise((resolve) => { resume = resolve; });
  const state = storage(t, {
    beforeExec: async (statement) => {
      if (/^\s*INSERT\s+INTO\s+todos\b/i.test(statement)) {
        reached();
        await continueInsert;
      }
    },
  });
  const pending = request(state, "POST", { id: uuid(1), title: "delayed" });
  await atInsert;
  try {
    assert.equal((await request(state, "DELETE", { id: uuid(1) })).status, 200);
  } finally {
    resume();
  }
  assert.equal((await pending).status, 409);
  assert.deepEqual((await request(state, "GET")).body, { todos: [] });
});

test("concurrent same intent is idempotent", { timeout: 3000 }, async (t) => {
  const state = storage(t, { legacy: true, beforeExec: beforeTodoInsert(2) });
  const body = { id: uuid(1), title: "same intent" };
  const replies = await Promise.all([request(state, "POST", body), request(state, "POST", body)]);
  assert.deepEqual(replies.map((r) => r.status), [201, 201]);
  assert.deepEqual(replies[0].body.todo, replies[1].body.todo);
  assert.equal(snapshot(state).length, 1);
});

test("999-capacity competition is enforced inside each single INSERT statement", { timeout: 3000 }, async (t) => {
  const state = storage(t, { legacy: true, beforeExec: beforeTodoInsert(2) });
  seed(state, 999);
  const replies = await Promise.all([
    request(state, "POST", { id: uuid(1000), title: "last slot A" }),
    request(state, "POST", { id: uuid(1001), title: "last slot B" }),
  ]);
  assert.deepEqual(replies.map((r) => r.status).sort(), [201, 409]);
  assert.equal(snapshot(state).length, 1000);
  const visible = (await request(state, "GET")).body.todos;
  assert.equal(visible.length, 1000);
  for (const reply of replies) {
    if (reply.status === 201) assert.ok(visible.some((todo) => todo.id === reply.body.todo.id));
  }
  assert.equal(state.calls.filter(({ statement }) => /^\s*SELECT\s+COUNT\b/i.test(statement)).length, 0, "capacity must not use a separate read/check");
});

test("an existing intent can be retried even when capacity is full", async (t) => {
  const state = storage(t, { legacy: true });
  seed(state, 1000);
  const reply = await request(state, "POST", { id: uuid(1), title: "seed 1" });
  assert.equal(reply.status, 201);
  assert.equal(reply.body.todo.created_at, 1);
  assert.equal(reply.body.todo.done, 1);
  assert.equal((await request(state, "POST", { id: uuid(1), title: "different" })).status, 409);
  assert.equal(snapshot(state).length, 1000);
});

test("a tombstone releases live capacity without allowing its UUID to be reused", async (t) => {
  const state = storage(t, { legacy: true });
  seed(state, 1000);
  await request(state, "DELETE", { id: uuid(1) });
  assert.equal((await request(state, "POST", { id: uuid(1001), title: "replacement" })).status, 201);
  assert.equal((await request(state, "POST", { id: uuid(1), title: "seed 1" })).status, 409);
  const visible = (await request(state, "GET")).body.todos;
  assert.equal(visible.length, 1000);
  assert.ok(!visible.some((todo) => todo.id === uuid(1)));
});

test("UUID validation requires a lowercase canonical v4 UUID", async (t) => {
  const invalid = [
    "-".repeat(36), "a".repeat(36), "", 42, null,
    "00000000-0000-1000-8000-000000000001",
    "00000000-0000-4000-7000-000000000001",
    "00000000-0000-4000-c000-000000000001",
    "00000000-0000-4000-8000-00000000000A",
    `${uuid(1)}\n`, `${uuid(1)} `,
    "000000000-000-4000-8000-000000000001",
  ];
  for (const id of invalid) {
    await t.test(`reject ${JSON.stringify(id)}`, async (t) => {
      const state = storage(t);
      for (const method of ["POST", "PATCH", "DELETE"]) {
        assert.equal((await request(state, method, { id, title: "bad UUID", done: true })).status, 400);
      }
      assert.equal(state.calls.length, 0, "invalid requests must not initialize storage");
    });
  }
  const state = storage(t);
  assert.equal((await request(state, "POST", { id: "abcdef01-abcd-4abc-babc-abcdef012345", title: "valid" })).status, 201);
});

test("share GET/HEAD on an empty database never write or initialize tables", async (t) => {
  const state = storage(t);
  state.onlyRead();
  for (const method of ["GET", "HEAD"]) {
    const reply = await request(state, method);
    assert.equal(reply.status, 200);
    assert.deepEqual(reply.body, { todos: [] });
  }
  assert.deepEqual(state.db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all(), []);
});

test("share reads of legacy rows need no migration", async (t) => {
  const state = storage(t, { legacy: true });
  seed(state, 2);
  const before = snapshot(state);
  const schema = state.db.prepare("SELECT name, sql FROM sqlite_schema ORDER BY name").all();
  state.onlyRead();
  assert.deepEqual((await request(state, "GET")).body.todos, JSON.parse(JSON.stringify(before)).sort((a, b) => a.created_at - b.created_at));
  assert.deepEqual(snapshot(state), before);
  assert.deepEqual(state.db.prepare("SELECT name, sql FROM sqlite_schema ORDER BY name").all(), schema);
});

test("the first upgraded write preserves legacy schema and rows", async (t) => {
  const state = storage(t, { legacy: true });
  seed(state, 2);
  const before = snapshot(state);
  const schema = state.db.prepare("SELECT sql FROM sqlite_schema WHERE name = 'todos'").get().sql;
  assert.equal((await request(state, "POST", { id: uuid(3), title: "new" })).status, 201);
  assert.deepEqual(snapshot(state).slice(0, 2), before);
  assert.equal(state.db.prepare("SELECT sql FROM sqlite_schema WHERE name = 'todos'").get().sql, schema);
  assert.equal((await request(state, "POST", { id: uuid(1), title: "seed 1" })).body.todo.created_at, 1);
});

test("redeploying the module keeps reads, old rows, timestamps and tombstones unchanged", async (t) => {
  const state = storage(t, { legacy: true });
  seed(state, 2);
  await request(state, "POST", { id: uuid(3), title: "new" });
  await request(state, "PATCH", { id: uuid(1), done: false });
  await request(state, "DELETE", { id: uuid(2) });
  const before = await request(state, "GET");
  const rows = snapshot(state);
  const schema = state.db.prepare("SELECT name, sql FROM sqlite_schema ORDER BY name").all();
  const reloaded = (await import(`${templateURL.href}?offline-redeploy`)).default;
  assert.notEqual(reloaded, app);
  state.onlyRead();
  assert.deepEqual(await request(state, "GET", undefined, reloaded), before);
  assert.ok(!before.body.todos.some((todo) => todo.id === uuid(2)));
  assert.deepEqual(snapshot(state), rows);
  assert.deepEqual(state.db.prepare("SELECT name, sql FROM sqlite_schema ORDER BY name").all(), schema);
});

test("titles remain parameter-bound and normalized intent retries are stable", async (t) => {
  const state = storage(t);
  const title = "x'); DROP TABLE todos; --";
  const created = await request(state, "POST", { id: uuid(1), title: `  ${title}  ` });
  assert.equal(created.status, 201);
  assert.equal(created.body.todo.title, title);
  assert.deepEqual((await request(state, "POST", { id: uuid(1), title })).body, created.body);
  for (const { statement } of state.calls) assert.ok(!statement.includes(title), "user titles must not enter SQL text");
  assert.equal((await request(state, "GET")).body.todos.length, 1);
});
