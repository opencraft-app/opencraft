import { MemoryFilesChangedError } from "../src/adapters/memory/file-authority.mjs";
import { legacyMemoryFixture } from "./helpers.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  existsSync,
  symlinkSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { spawnSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import { Store } from "../src/store.mjs";
import { MemoryFileTransaction } from "../src/adapters/memory/file-transaction.mjs";
import { MemoryFileStore } from "../src/adapters/memory/file-store.mjs";
import { profileFor, root, running, until, childRunner } from "./helpers.mjs";
import { initProfile } from "../src/profile.mjs";
const execute = promisify(execFile);

test("new shard metadata is initialized under the existing root write lock", (t) => {
  const profile = profileFor(t),
    original = MemoryFileStore.prototype.initialize;
  let observed = 0,
    store;
  MemoryFileStore.prototype.initialize = function () {
    const owner = JSON.parse(
      readFileSync(join(this.root, ".write-lock", "owner.json"), "utf8"),
    );
    assert.equal(owner.pid, process.pid);
    observed++;
    return original.call(this);
  };
  try {
    store = new Store(profile);
    assert.equal(observed, 1);
    assert.equal(
      existsSync(join(profile.path, "memory-space", ".write-lock")),
      false,
    );
  } finally {
    store?.close();
    MemoryFileStore.prototype.initialize = original;
  }
});

test("reclaiming a known-dead lock gets one immediate acquisition attempt even if the wait deadline elapsed", (t) => {
  const p = profileFor(t),
    directory = join(p.path, "lock-probe");
  mkdirSync(directory);
  const lock = join(directory, ".write-lock");
  mkdirSync(lock);
  writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: 2147483647 }));
  const transaction = new MemoryFileTransaction({ root: directory }, {});
  const originalNow = Date.now,
    originalKill = process.kill;
  let now = 0;
  try {
    Date.now = () => now;
    process.kill = (pid, signal) => {
      assert.equal(pid, 2147483647);
      assert.equal(signal, 0);
      now = 500;
      const error = new Error("known dead owner");
      error.code = "ESRCH";
      throw error;
    };
    transaction.acquire();
    assert.equal(
      JSON.parse(readFileSync(join(lock, "owner.json"), "utf8")).pid,
      process.pid,
    );
    transaction.release();
  } finally {
    Date.now = originalNow;
    process.kill = originalKill;
  }
  // Existing live/own ownership remains a conflict; do not remove an uncertain lock.
  mkdirSync(lock);
  writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: process.pid }));
  assert.throws(() => transaction.acquire(), /busy/);
  assert.equal(
    JSON.parse(readFileSync(join(lock, "owner.json"), "utf8")).pid,
    process.pid,
  );
});
const open = (t, p) => {
  const s = new Store(p);
  t.after(() => s.close());
  return s;
};
const set = (app, key, value, scope = "user", project) =>
  app.memory.change(crypto.randomUUID(), "memory.set", {
    key,
    value,
    scope,
    project,
    expectedRevision: 0,
  });
function capture(app, id = "input", text = "I have a new lasting preference") {
  app.reception.accept(id, { text });
  app.reception.apply(app.reception.turn(id), {
    kind: "reply",
    text: "Understood",
  });
  return app.memoryLearning.get(`learning:${id}`);
}
function shared(t) {
  const a = profileFor(t),
    storage = join(a.path, "shared-memory");
  a.config.memoryRoot = storage;
  const b = profileFor(t, { memoryRoot: storage });
  return { a, b, storage };
}
const create = (app, slug) =>
  app.memoryProjects.change(crypto.randomUUID(), "create", {
    slug,
    name: `Project ${slug}`,
  });
const joinProject = (app, slug) =>
  app.memoryProjects.change(crypto.randomUUID(), "join", { slug });
const leave = (app, slug) =>
  app.memoryProjects.change(crypto.randomUUID(), "leave", { slug });

test("new profiles default to private agent memory; old configuration keeps user scope", (t) => {
  const p = profileFor(t, { memoryDefaultScope: "agent" }),
    { app } = open(t, p);
  const result = app.memory.change("private", "memory.set", {
    key: "role",
    value: "Prefers technical details",
    expectedRevision: 0,
  });
  assert.equal(result.key, "@agent/role");
  assert.equal(app.memory.list()[0].scope, "agent");
  assert.match(
    readFileSync(
      join(app.memory.files.locations().agent, "profile.md"),
      "utf8",
    ),
    /Prefers technical details/,
  );
  const config = join(p.path, "profile.json"),
    raw = JSON.parse(readFileSync(config));
  delete raw.memoryDefaultScope;
  writeFileSync(config, JSON.stringify(raw));
  // Read-only configuration load must not rewrite the missing setting into the file.
  return import("../src/profile.mjs").then(({ loadProfile }) => {
    assert.equal(loadProfile(p.path).config.memoryDefaultScope, "user");
    assert.equal(
      JSON.parse(readFileSync(config)).memoryDefaultScope,
      undefined,
    );
  });
});

test("Markdown edits are authoritative; stale SQL rows rebuild from files and never overwrite edits", (t) => {
  const { app, db } = open(t, profileFor(t));
  set(app, "city", "Lives in Shanghai");
  const path = join(app.memory.files.locations().user, "profile.md");
  writeFileSync(
    path,
    "# User\n\nKeep this unparsed human note.\n\n- (2026-11-03) Lives in Shenzhen\n",
  );
  assert.deepEqual(
    app.memory.list().map((m) => m.value),
    ["Lives in Shenzhen"],
  );
  db.exec(
    "DELETE FROM memory_shard; DELETE FROM memory_detail; DELETE FROM memory_provenance; DELETE FROM memory;",
  );
  assert.deepEqual(
    app.memory.list().map((m) => m.value),
    ["Lives in Shenzhen"],
  );
  set(app, "language", "Uses Chinese");
  assert.match(readFileSync(path, "utf8"), /Keep this unparsed human note/);
  assert.doesNotMatch(readFileSync(path, "utf8"), /Shanghai/);
});

test("two assistants share user facts with provenance, keep private facts isolated and only write their own shard", (t) => {
  const f = shared(t),
    a = open(t, f.a),
    b = open(t, f.b);
  set(a.app, "private", "Private A role", "agent");
  set(a.app, "user", "Prefers concise answers");
  assert.deepEqual(
    b.app.memory.list().map((m) => m.value),
    ["Prefers concise answers"],
  );
  const fact = b.app.memory.list()[0];
  assert.equal(fact.agentId, f.a.config.assistantId);
  assert.throws(
    () =>
      b.app.memory.change("steal", "memory.forget", {
        key: fact.key,
        expectedRevision: fact.revision,
      }),
    /another assistant/,
  );
  assert.throws(
    () =>
      b.app.memory.readFile({
        scope: "agent",
        agentId: f.a.config.assistantId,
        path: "profile.md",
      }),
    /not shared/,
  );
  set(b.app, "same", "Prefers concise answers");
  assert.equal(
    a.app.memory.list().filter((m) => m.value === "Prefers concise answers")
      .length,
    2,
  );
  assert.equal(
    readFileSync(
      join(a.app.memory.files.locations().agent, "profile.md"),
      "utf8",
    ).includes("Private A role"),
    true,
  );
  const sharedFile = b.app.memory.readFile({
    scope: "user",
    agentId: f.a.config.assistantId,
    path: "profile.md",
  });
  assert.match(sharedFile.content, /Prefers concise/);
});

test("project membership gates other-agent facts; create-is-join preserves description, leave/rejoin retires the old grant", (t) => {
  const f = shared(t),
    a = open(t, f.a),
    b = open(t, f.b);
  create(a.app, "alpha");
  set(a.app, "decision", "Use SQLite for tasks", "project", "alpha");
  assert.deepEqual(b.app.memory.list(), []);
  joinProject(b.app, "alpha");
  const before = b.app.scope.delegate("old").resources;
  assert.equal(b.app.memory.prompt(before).projects.injected[0].slug, "alpha");
  const path = join(f.storage, "projects/alpha/project.md"),
    original = readFileSync(path, "utf8");
  b.app.memoryProjects.change("create-existing", "create", {
    slug: "alpha",
    name: "Do not replace",
  });
  assert.equal(readFileSync(path, "utf8"), original);
  leave(b.app, "alpha");
  assert.equal(b.app.memory.prompt(before).projects.injected.length, 0);
  joinProject(b.app, "alpha");
  assert.equal(b.app.memory.prompt(before).projects.injected.length, 0);
  assert.equal(b.app.memory.prompt().projects.injected.length, 1);
  assert.throws(
    () =>
      b.app.memory.readFile(
        { scope: "project", project: "alpha", path: "profile.md" },
        before,
      ),
    /original grant/,
  );
});

test("up to three joined projects are injected with agent provenance and other memberships listed", (t) => {
  const f = shared(t),
    a = open(t, f.a),
    b = open(t, f.b);
  for (const slug of ["delta", "charlie", "bravo", "alpha"]) {
    create(a.app, slug);
    set(a.app, "plan", `Plan for ${slug}`, "project", slug);
    joinProject(b.app, slug);
  }
  const context = b.app.memory.prompt();
  assert.equal(context.projects.injected.length, 3);
  assert.equal(context.projects.alsoMemberOf.length, 1);
  assert.equal(
    context.projects.injected[0].profile[0].agentId,
    f.a.config.assistantId,
  );
  assert.deepEqual(context.precedence, ["agent", "project", "user"]);
  b.app.reception.accept("remember-context", {
    text: "Compare the projects and their plan",
  });
  const initial = b.app.reception.context(
    b.app.reception.turn("remember-context"),
  );
  assert.equal(initial.memoryContext.projects.injected.length, 3);
  const initialProjects = new Set(
    [
      ...initial.memoryContext.profile,
      ...initial.memoryContext.recent,
      ...initial.memoryRecall,
    ]
      .filter((m) => m.scope === "project")
      .map((m) => m.projectId),
  );
  assert.equal(initialProjects.size, 3);
  const omitted = initial.memoryContext.projects.alsoMemberOf[0].slug;
  assert.ok(!initialProjects.has(omitted));
  const explicit = b.app.receptionQueries
    .open(b.app.reception.turn("remember-context"))
    .execute({
      kind: "query",
      name: "memory.search",
      params: { query: "Plan for " + omitted },
    });
  assert.ok(explicit.response.data.items.some((m) => m.projectId === omitted));
  assert.equal(initial.capabilities.resources.includes("materials"), false);
  assert.ok(
    !b.app.scope.delegate("project-only").tools.includes("read_material"),
  );
  assert.ok(
    !b.app.scope.delegate("project-only").tools.includes("list_materials"),
  );
});

test("automatic learning cannot update another agent shard; can write its own joined project shard", (t) => {
  const f = shared(t),
    a = open(t, f.a),
    b = open(t, f.b);
  create(a.app, "alpha");
  joinProject(b.app, "alpha");
  set(a.app, "preference", "Use short reports", "project", "alpha");
  const job = capture(b.app);
  assert.equal(job.snapshot.facts.length, 0);
  assert.equal(job.snapshot.sharedMemories.length, 1);
  assert.throws(
    () =>
      b.app.memoryLearning.proposed(job.id, {
        changes: [
          {
            action: "remove",
            id: job.snapshot.sharedMemories[0].id,
            sourceEvidenceIds: [job.evidence[0].id],
          },
        ],
      }),
    /Unknown/,
  );
  b.app.memoryLearning.proposed(job.id, {
    changes: [
      {
        action: "create",
        scope: "project",
        project: "alpha",
        kind: "log",
        content: "Project deadline is November 10",
        sourceEvidenceIds: [job.evidence[0].id],
      },
    ],
  });
  assert.equal(
    b.app.memoryLearning.finish(job.id, { approved: true }).state,
    "committed",
  );
  assert.equal(
    a.app.memory.list().find((m) => m.value.includes("deadline")).agentId,
    f.b.config.assistantId,
  );
});

test("membership revocation while a proposal is being reviewed cannot apply a project change", (t) => {
  const f = shared(t),
    a = open(t, f.a);
  create(a.app, "alpha");
  const job = capture(a.app);
  a.app.memoryLearning.proposed(job.id, {
    changes: [
      {
        action: "create",
        scope: "project",
        project: "alpha",
        kind: "profile",
        content: "Deadline November 10",
        sourceEvidenceIds: [job.evidence[0].id],
      },
    ],
  });
  leave(a.app, "alpha");
  assert.throws(
    () => a.app.memoryLearning.finish(job.id, { approved: true }),
    /membership changed/,
  );
  assert.deepEqual(a.app.memory.list(), []);
});

test("file write failure rolls back Markdown, SQL, input receipt and epoch together", (t) => {
  const s = open(t, profileFor(t));
  set(s.app, "city", "Lives in Shanghai");
  const original = s.app.memory.files.locations().user,
    body = readFileSync(join(original, "profile.md"), "utf8"),
    epoch = s.app.memory.epoch();
  const participant = s.uow.participants[0],
    write = participant.store.atomic.bind(participant.store);
  let injected = false;
  participant.store.atomic = (path, text) => {
    if (!injected && path.endsWith("profile.md")) {
      injected = true;
      throw new Error("injected disk failure");
    }
    return write(path, text);
  };
  assert.throws(
    () =>
      s.app.memory.change("failed", "memory.set", {
        key: "city",
        value: "Lives in Shenzhen",
        expectedRevision: 1,
      }),
    /disk failure/,
  );
  participant.store.atomic = write;
  assert.equal(readFileSync(join(original, "profile.md"), "utf8"), body);
  assert.equal(s.app.memory.epoch(), epoch);
  assert.equal(s.app.r.inputs.get("failed"), undefined);
  assert.equal(
    s.app.memory.change("failed", "memory.set", {
      key: "city",
      value: "Lives in Shenzhen",
      expectedRevision: 1,
    }).revision,
    2,
  );
});

test("nested rollback discards staged membership and file effects while the outer command may continue", (t) => {
  const s = open(t, profileFor(t));
  s.uow.transaction(() => {
    assert.throws(
      () =>
        s.uow.transaction(() => {
          create(s.app, "temporary");
          throw new Error("undo nested");
        }),
      /undo nested/,
    );
    set(s.app, "ok", "A stable fact");
  });
  assert.deepEqual(s.app.memoryProjects.list(), []);
  assert.deepEqual(
    s.app.memory.list().map((m) => m.value),
    ["A stable fact"],
  );
  assert.equal(
    existsSync(
      join(s.profile.path, "memory-space/projects/temporary/identity.json"),
    ),
    false,
  );
});

for (const window of [
  "memory-files-before-sql-commit",
  "memory-files-after-sql-commit",
])
  test(`real process crash recovers ${window} without replaying a committed write`, (t) => {
    const profile = profileFor(t);
    let s = new Store(profile);
    set(s.app, "existing", "Keep this fact");
    s.close();
    const script = `import {Store} from './src/store.mjs';import {loadProfile} from './src/profile.mjs';const s=new Store(loadProfile(process.argv[1]));s.app.memory.change('crash-input','memory.set',{key:'crash',value:'Crash fact',expectedRevision:0});`;
    const child = spawnSync(
      process.execPath,
      ["--input-type=module", "--eval", script, profile.path],
      {
        cwd: root,
        env: { ...process.env, LAB_TEST_CRASH_AT: window },
        encoding: "utf8",
      },
    );
    assert.equal(child.status, 86, child.stderr);
    s = new Store(profile);
    t.after(() => s.close());
    assert.ok(s.app.memory.list().some((m) => m.value === "Keep this fact"));
    const committed = window.includes("after-sql");
    assert.equal(
      s.app.memory.list().some((m) => m.value === "Crash fact"),
      committed,
    );
    const result = s.app.memory.change("crash-input", "memory.set", {
      key: "crash",
      value: "Crash fact",
      expectedRevision: 0,
    });
    assert.equal(!!result.duplicate, committed);
    assert.equal(result.revision, 1);
    assert.equal(
      existsSync(join(profile.path, "memory-space/.transactions/pending.json")),
      false,
    );
  });

test("recovery detects a third-party file edit and preserves it instead of overwriting", (t) => {
  const profile = profileFor(t);
  let s = new Store(profile);
  set(s.app, "existing", "Keep fact");
  const path = join(s.app.memory.files.locations().user, "profile.md");
  s.close();
  const script = `import {Store} from './src/store.mjs';import {loadProfile} from './src/profile.mjs';const s=new Store(loadProfile(process.argv[1]));s.app.memory.change('crash','memory.set',{key:'new',value:'Pending fact',expectedRevision:0});`;
  const child = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", script, profile.path],
    {
      cwd: root,
      env: {
        ...process.env,
        LAB_TEST_CRASH_AT: "memory-files-before-sql-commit",
      },
      encoding: "utf8",
    },
  );
  assert.equal(child.status, 86, child.stderr);
  const edit = "- (2026-11-03) External edit must survive\n";
  writeFileSync(path, edit);
  assert.throws(() => new Store(profile), /conflicts with external edit/);
  assert.equal(readFileSync(path, "utf8"), edit);
});

test("memory paths reject symlinks, traversal and malformed metadata; errors never replace files with an empty database", (t) => {
  const s = open(t, profileFor(t));
  set(s.app, "fact", "Known fact");
  assert.throws(
    () => s.app.memory.readFile({ path: "../../profile.json" }),
    /Only memory/,
  );
  const own = s.app.memory.files.locations().user;
  writeFileSync(join(own, ".dreaming/records.json"), "{broken");
  assert.throws(() => s.app.memory.list(), /Malformed memory/);
  assert.match(readFileSync(join(own, "profile.md"), "utf8"), /Known fact/);
});

test("a foreign owner cannot join a shared root", (t) => {
  const f = shared(t);
  open(t, f.a);
  f.b.config.owner = "local:another-owner";
  assert.throws(() => new Store(f.b), /another owner/);
});

test("real CLI creates/joins a project, writes its own file-backed shard and reads Markdown through the socket", async (t) => {
  const { profile, runner } = await running(t);
  const cli = async (args) => {
    const { stdout } = await execute(
      process.execPath,
      ["bin/assistant.mjs", ...args, "--profile", profile.path],
      { cwd: root },
    );
    return JSON.parse(stdout).result;
  };
  assert.equal(
    (await cli(["project-create", "--project", "alpha", "--name", "Alpha"]))
      .joined,
    true,
  );
  await cli([
    "memory-set",
    "--scope",
    "project",
    "--project",
    "alpha",
    "--key",
    "deadline",
    "--value",
    "Deadline is November 10",
  ]);
  assert.match(
    (
      await cli([
        "memory-file",
        "--scope",
        "project",
        "--project",
        "alpha",
        "--path",
        "profile.md",
      ])
    ).content,
    /Deadline is November 10/,
  );
  await cli(["project-leave", "--project", "alpha"]);
  assert.deepEqual(await cli(["project-list"]), []);
  assert.equal(runner.app.memory.list().length, 0);
});

test("private-agent daily review and projects named user keep separate refresh markers", (t) => {
  const { app } = open(t, profileFor(t, { memoryDefaultScope: "agent" }));
  set(app, "private", "A private role", "agent");
  create(app, "user");
  app.uow.transaction(() => {
    app.memory.reviewed(null, 86400000);
    app.memory.reviewed("user", 1234567);
  });
  assert.equal(app.memory.reviewDue(null), false);
  assert.equal(app.memory.reviewDue("user"), false);
  assert.equal(
    existsSync(
      join(app.memory.files.locations().agent, ".dreaming/next-refresh-at"),
    ),
    true,
  );
  assert.equal(
    existsSync(
      join(
        app.memory.files.locations().root,
        "projects/user/memory/agents",
        app.agentId ?? app.assistant.id,
        ".dreaming/next-refresh-at",
      ),
    ),
    true,
  );
});

test("symlinked monthly logs are rejected without reading the linked target", (t) => {
  const p = profileFor(t),
    { app } = open(t, p);
  set(app, "known", "Known fact");
  const log = join(app.memory.files.locations().user, "log");
  mkdirSync(log);
  symlinkSync(join(p.path, "profile.json"), join(log, "2026-11.md"));
  assert.throws(() => app.memory.list(), /symlinks|Invalid memory directory/);
  assert.equal(
    JSON.parse(readFileSync(join(p.path, "profile.json"))).assistantId,
    p.config.assistantId,
  );
});

test("another agent can recover the shared root after its writer crashed", (t) => {
  const f = shared(t);
  writeFileSync(join(f.a.path, "profile.json"), JSON.stringify(f.a.config));
  const a = new Store(f.a),
    b = new Store(f.b);
  a.close();
  b.close();
  const script = `import {Store} from './src/store.mjs';import {loadProfile} from './src/profile.mjs';const s=new Store(loadProfile(process.argv[1]));s.app.memory.change('crash','memory.set',{key:'new',value:'Committed shared fact',scope:'user',expectedRevision:0});`;
  const child = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", script, f.a.path],
    {
      cwd: root,
      env: {
        ...process.env,
        LAB_TEST_CRASH_AT: "memory-files-after-sql-commit",
      },
      encoding: "utf8",
    },
  );
  assert.equal(child.status, 86, child.stderr);
  const recovered = open(t, f.b);
  assert.ok(
    recovered.app.memory
      .list()
      .some((m) => m.value === "Committed shared fact"),
  );
});

test("Pi actually reads the Markdown tool and receives joined project memory in its immutable snapshot", async (t) => {
  const { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall } =
    await import("@earendil-works/pi-ai");
  const { PiExecutionAdapter } = await import(
    "../src/adapters/pi/pi-execution-adapter.mjs"
  );
  const { createExecutionPorts } = await import(
    "../src/runtime/execution-ports.mjs"
  );
  const { LocalArtifactStore } = await import(
    "../src/adapters/filesystem/artifact-store.mjs"
  );
  const profile = profileFor(t),
    s = open(t, profile);
  create(s.app, "alpha");
  set(s.app, "decision", "Use the original project plan", "project", "alpha");
  const receipt = s.app.works.submit("work", {
      text: "Read the project memory",
    }),
    work = s.app.workRecord(receipt.workId);
  const models = createModels(),
    faux = fauxProvider({ tokensPerSecond: 100000 });
  faux.setResponses([
    fauxAssistantMessage(
      [
        fauxToolCall("read_memory_file", {
          scope: "project",
          project: "alpha",
          path: "profile.md",
        }),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      [
        fauxToolCall("publish_note", {
          body: "The original project plan is confirmed.",
        }),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("done"),
  ]);
  models.setProvider(faux.provider);
  const ports = createExecutionPorts(s.app),
    observed = [];
  const adapter = new PiExecutionAdapter({
    profile,
    ...ports,
    toolsFor: (work, snapshot) => {
      const tools = ports.toolsFor(work, snapshot);
      return {
        ...tools,
        readMemoryFile: (args) => {
          const result = tools.readMemoryFile(args);
          observed.push(result);
          return result;
        },
      };
    },
    catalog: {
      forExecution: () => ({
        models,
        model: { provider: "faux", modelId: "faux-1" },
      }),
    },
    artifactStore: new LocalArtifactStore(join(profile.path, "artifacts")),
    knowledgeSource: null,
  });
  s.app.executions.started(work);
  assert.equal(await adapter.run(work, new AbortController().signal), "done");
  assert.match(observed[0].content, /original project plan/);
  const snapshot = s.app.executions.snapshot(work);
  assert.equal(snapshot.memoryContext.projects.injected[0].slug, "alpha");
  assert.ok(snapshot.delegation.tools.includes("read_memory_file"));
});

test("main assistant project commands and named project memory execute through the existing owners", (t) => {
  const { app } = open(t, profileFor(t));
  app.reception.accept("create", {
    text: "Create the Alpha shared memory project",
  });
  app.reception.apply(app.reception.turn("create"), {
    kind: "project.create",
    project: "alpha",
    name: "Alpha",
  });
  app.reception.accept("remember", { text: "Remember the project deadline" });
  app.reception.apply(app.reception.turn("remember"), {
    kind: "remember",
    scope: "project",
    project: "alpha",
    key: "deadline",
    value: "Deadline November 10",
    expectedRevision: 0,
  });
  assert.equal(app.memory.list()[0].projectId, "alpha");
  app.reception.accept("leave", { text: "Leave Alpha" });
  app.reception.apply(app.reception.turn("leave"), {
    kind: "project.leave",
    project: "alpha",
  });
  assert.deepEqual(app.memoryProjects.list(), []);
  assert.deepEqual(app.memory.list(), []);
});

test("schema14 migrates once, preserves keys/revisions/provenance/unknown dates and keeps a full raw backup", async (t) => {
  const profile = profileFor(t);
  let s = new Store(profile);
  set(s.app, "city", "Lives in Shanghai");
  set(s.app, "forgot", "Old forgotten fact");
  s.app.memory.change("forget", "memory.forget", {
    key: "forgot",
    expectedRevision: 1,
  });
  legacyMemoryFixture(profile, s.db);
  s.db.prepare("UPDATE memory_detail SET updated_at=0 WHERE key=?").run("city");
  s.db
    .prepare("INSERT INTO memory VALUES(?,?,1,?,0)")
    .run("legacy-long", "x".repeat(2000), "legacy");
  s.db.exec(
    "DROP TABLE execution_native_receipt; ALTER TABLE execution DROP COLUMN harness; PRAGMA user_version=14",
  );
  s.close();
  s = new Store(profile);
  t.after(() => s.close());
  const city = s.app.memory.list().find((m) => m.key === "city");
  assert.equal(city.revision, 1);
  assert.equal(city.updatedAt, 0);
  assert.equal(
    s.app.memory
      .learningSnapshot()
      .facts.find((f) => f.content === "Lives in Shanghai").origin,
    "explicit",
  );
  const backup = JSON.parse(
    readFileSync(join(profile.path, "memory-migration-schema14.json")),
  );
  assert.equal(
    backup.rows.find((m) => m.key === "legacy-long").value.length,
    2000,
  );
  assert.equal(
    s.app.memory.list().find((m) => m.key === "legacy-long").value.length,
    500,
  );
  const job = capture(s.app);
  s.app.memoryLearning.proposed(job.id, {
    changes: [
      {
        action: "create",
        content: "Old forgotten fact",
        kind: "profile",
        sourceEvidenceIds: [job.evidence[0].id],
      },
    ],
  });
  s.app.memoryLearning.finish(job.id, { approved: true });
  assert.ok(!s.app.memory.list().some((m) => m.value === "Old forgotten fact"));
  assert.match(
    readFileSync(
      join(s.app.memory.files.locations().user, "profile.md"),
      "utf8",
    ),
    /0000-00-00/,
  );
});

test("another agent automatic learning refreshes shared context without fencing active work; explicit correction still fences", (t) => {
  const f = shared(t),
    a = open(t, f.a),
    b = open(t, f.b);
  const receipt = b.app.works.submit("work", { text: "Keep working" }),
    work = b.app.workRecord(receipt.workId),
    snapshot = b.app.executions.snapshot(work);
  const epoch = b.app.memory.guardEpoch(),
    job = capture(a.app);
  a.app.memoryLearning.proposed(job.id, {
    changes: [
      {
        action: "create",
        scope: "user",
        kind: "profile",
        content: "Prefers concise replies",
        sourceEvidenceIds: [job.evidence[0].id],
      },
    ],
  });
  a.app.memoryLearning.finish(job.id, { approved: true });
  assert.ok(
    b.app.memory.list().some((m) => m.value === "Prefers concise replies"),
  );
  assert.equal(b.app.memory.guardEpoch(), epoch);
  b.app.executions.assertAction(work, "publish_note", undefined, {
    epoch: snapshot.explicitMemoryEpoch,
  });
  set(a.app, "explicit", "Prefers detailed replies");
  assert.ok(b.app.memory.guardEpoch() > epoch);
  assert.throws(
    () =>
      b.app.executions.assertAction(work, "publish_note", undefined, {
        epoch: snapshot.explicitMemoryEpoch,
      }),
    /memory/i,
  );
});

test("two fresh processes can initialize and write separate shards in the same root without overwriting ownership", async (t) => {
  const f = shared(t);
  writeFileSync(join(f.a.path, "profile.json"), JSON.stringify(f.a.config));
  const script = `import {Store} from './src/store.mjs';import {loadProfile} from './src/profile.mjs';const s=new Store(loadProfile(process.argv[1]));s.app.memory.change('init-fact','memory.set',{key:'fact',value:process.argv[2],scope:'user',expectedRevision:0});s.close();`;
  const results = await Promise.allSettled(
    [f.a, f.b].map((p, i) =>
      execute(
        process.execPath,
        ["--input-type=module", "--eval", script, p.path, `Fact from ${i}`],
        { cwd: root },
      ),
    ),
  );
  assert.ok(
    results.every((r) => r.status === "fulfilled"),
    JSON.stringify(results),
  );
  const s = open(t, f.a);
  assert.deepEqual(
    s.app.memory
      .list()
      .map((m) => m.value)
      .sort(),
    ["Fact from 0", "Fact from 1"],
  );
});

test("file catalogue pages authorized shards and rejects revoked project references after rejoin", (t) => {
  const f = shared(t),
    a = open(t, f.a),
    b = open(t, f.b);
  set(a.app, "private", "Private writer fact", "agent");
  set(a.app, "shared", "Shared writer fact", "user");
  create(a.app, "alpha");
  set(a.app, "plan", "Alpha project fact", "project", "alpha");
  joinProject(b.app, "alpha");
  set(b.app, "private", "Reader private fact", "agent");
  const resources = structuredClone(b.app.scope.resources),
    all = [];
  let after;
  do {
    const page = b.app.memory.listFiles({ limit: 1, after }, resources);
    all.push(...page.items);
    after = page.next ?? undefined;
  } while (after);
  assert.equal(all.length, 3);
  assert.equal(
    all.some(
      (d) => d.scope === "agent" && d.agentId === f.a.config.assistantId,
    ),
    false,
  );
  const project = all.find((d) => d.scope === "project");
  assert.equal(project.project, "alpha");
  const params = Object.fromEntries(
    Object.entries(project).filter(
      ([k, v]) => k !== "documentId" && v !== null,
    ),
  );
  assert.match(
    b.app.memory.readFile(params, resources).content,
    /Alpha project fact/,
  );
  leave(b.app, "alpha");
  joinProject(b.app, "alpha");
  assert.equal(
    b.app.memory
      .listFiles({}, resources)
      .items.some((d) => d.scope === "project"),
    false,
  );
  assert.throws(
    () => b.app.memory.readFile(params, resources),
    /original grant/,
  );
  assert.equal(
    b.app.memory.listFiles().items.some((d) => d.scope === "project"),
    true,
  );
});


test("external file conflicts are typed only after rollback, preserve disk edits and permit a fresh transaction", (t) => {
  const s = open(t, profileFor(t));
  const authority = s.uow.participants.find((p) => p.store instanceof MemoryFileStore);
  assert.ok(authority);
  set(s.app, "seed", "initial memory creates the user shard");
  const file = join(s.app.memory.files.locations().user, "profile.md");
  const external = "# External edit\n\nA concurrent user edit must not be overwritten.\n";
  assert.throws(() => s.uow.transaction(() => {
    set(s.app, "conflicting", "must not commit");
    // Edit after the staged command captured its file snapshot, before prepare.
    writeFileSync(file, external);
  }), (error) => error instanceof MemoryFilesChangedError);
  assert.equal(s.uow.depth, 0);
  assert.equal(readFileSync(file, "utf8"), external);
  assert.equal(existsSync(join(authority.store.root, ".write-lock")), false);
  assert.ok(!s.app.memory.list().some((m) => m.value === "must not commit"));
  set(s.app, "fresh", "fresh transaction succeeds");
  assert.ok(s.app.memory.list().some((m) => m.value === "fresh transaction succeeds"));
});

test("a lock is claimed with its owner already inside, and dead claimers' staging is swept", (t) => {
  const p = profileFor(t),
    directory = join(p.path, "lock-staging");
  mkdirSync(directory);
  // A claimer killed before renaming its staging directory into place.
  const abandoned = join(directory, ".write-lock.2147483647.dead");
  mkdirSync(abandoned);
  const transaction = new MemoryFileTransaction({ root: directory }, {});
  transaction.claim();
  assert.equal(
    JSON.parse(readFileSync(join(directory, ".write-lock", "owner.json"), "utf8")).pid,
    process.pid,
  );
  assert.equal(existsSync(abandoned), false);
  // A second claim onto the held lock reports it as taken and leaves no staging behind.
  assert.throws(() => new MemoryFileTransaction({ root: directory }, {}).claim(), { code: "EEXIST" });
  assert.deepEqual(readdirSync(directory), [".write-lock"]);
  transaction.release();
  assert.deepEqual(readdirSync(directory), []);
});

test("processes taking turns on one root never lose or remove each other's lock", async (t) => {
  const p = profileFor(t),
    directory = join(p.path, "lock-turns");
  mkdirSync(directory);
  // Releasing used to empty the lock in place; another claimer's rename could
  // replace the empty directory, and the release then failed (ENOTEMPTY).
  const script = `import {MemoryFileTransaction} from './src/adapters/memory/file-transaction.mjs';
const t=new MemoryFileTransaction({root:process.argv[1]},{});
for(let i=0;i<300;i++){try{t.acquire();}catch(e){if(e.code==='MEMORY_BUSY')continue;throw e;}t.release();}`;
  const results = await Promise.allSettled(
    Array.from({ length: 6 }, () =>
      execute(process.execPath, ["--input-type=module", "--eval", script, directory], { cwd: root }),
    ),
  );
  assert.ok(
    results.every((r) => r.status === "fulfilled"),
    JSON.stringify(results.filter((r) => r.status === "rejected").map((r) => String(r.reason?.stderr ?? r.reason))),
  );
  assert.deepEqual(readdirSync(directory), []);
});

test("a release never removes a lock that another owner holds at the lock path", (t) => {
  const p = profileFor(t),
    directory = join(p.path, "lock-takeover");
  mkdirSync(directory);
  const first = new MemoryFileTransaction({ root: directory }, {});
  first.claim();
  // Simulate a takeover: the first owner's lock is gone and another owner holds the path.
  rmSync(join(directory, ".write-lock"), { recursive: true });
  const second = new MemoryFileTransaction({ root: directory }, {});
  second.claim();
  assert.throws(() => first.release(), /taken over/);
  assert.equal(
    JSON.parse(readFileSync(join(directory, ".write-lock", "owner.json"), "utf8")).token,
    second.token,
  );
  second.release();
  assert.deepEqual(readdirSync(directory), []);
});
