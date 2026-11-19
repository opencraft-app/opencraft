import { legacyMemoryFixture } from "./helpers.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { join, relative } from "node:path";
import { execFileSync } from "node:child_process";
import { initProfile, loadProfile } from "../src/adapters/local/profile.mjs";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../src/store.mjs";
import { DirectoryKnowledgeSource } from "../src/adapters/filesystem/knowledge-source.mjs";
import { ScopePolicy } from "../src/application/scope-policy.mjs";
import { Assistant } from "../src/domain/assistant.mjs";
import { profileFor, root } from "./helpers.mjs";

function modules(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? modules(join(directory, entry.name))
      : entry.name.endsWith(".mjs")
        ? [join(directory, entry.name)]
        : [],
  );
}

test("domain/application dependencies and SQL ownership stay within their declared layers", () => {
  for (const layer of ["domain", "application", "ports"])
    for (const file of modules(join(root, "src", layer))) {
      const source = readFileSync(file, "utf8");
      const imports = [...source.matchAll(/(?:from\s*|import\s*\()\s*['"]([^'"]+)['"]/g)].map((match) => match[1]);
      for (const id of imports) {
        if (id.startsWith("node:")) assert.equal(id, "node:crypto", `${file} imports IO ${id}`);
        else assert.ok(id.startsWith(".") && !/adapters|runtime|interfaces/.test(id), `${file} imports concrete ${id}`);
      }
      assert.doesNotMatch(source, /\.prepare\s*\(|new DatabaseSync\b/, `${file} contains persistence logic`);
    }
});

test("application services do not bypass the declared aggregate write owners", () => {
  const owners = {
    usage: "usage-service.mjs",
    skills: "skill-service.mjs",
    works: "work-service.mjs",
    inputs: "input-inbox.mjs",
    executions: "execution-ledger.mjs",
    outcomes: "outcome-ledger.mjs",
    memories: "memory-service.mjs",
    routines: "routine-service.mjs",
    conversations: "conversation-history.mjs",
    reception: "reception-service.mjs",
    interactions: "interaction-ledger.mjs",
    completion: "completion-ledger.mjs",
  };
  for (const file of modules(join(root, "src/application"))) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(
      /this\.(?:r\.)?(usage|works|inputs|executions|outcomes|memories|routines|conversations|reception|interactions|completion)\.(add|save|detail|retire|rejectPending|status|bind|context|withdraw|addResult|addDelivery|addEvidence|addAssessment|accepted|failed|delivered|link|append|started|settled|blocked)\(/g,
    )) {
      // Calls to named application services (works/ledger/etc.) are allowed; this rule targets repository field access.
      if (match[0].startsWith("this.r.") || match[1] === "inputs")
        assert.ok(file.endsWith(owners[match[1]]), `${file} directly writes ${match[1]}`);
    }
  }
});

test("a business execution cannot silently replace an existing native binding", (t) => {
  const store = new Store(profileFor(t));
  t.after(() => store.close());
  const receipt = store.submit("binding", { text: "one work" }),
    work = store.work(receipt.workId);
  store.bound(work, 11, 22);
  assert.throws(() => store.bound(work, 11, 99), /submission binding changed/);
  assert.throws(() => store.bound(work, 99, 22), /conversation binding changed/);
  assert.equal(store.execution(work).submission_id, "22");
});

test("workspace binding remains canonical when the runner restarts from a different directory", (t) => {
  const outer = profileFor(t),
    materials = join(outer.path, "materials");
  mkdirSync(materials);
  const profile = initProfile(join(outer.path, "nested"), "local:binding-test", {
    workspace: relative(process.cwd(), materials),
  });
  assert.equal(JSON.parse(readFileSync(join(profile.path, "profile.json"), "utf8")).workspace, materials);
  const script = `import {loadProfile} from ${JSON.stringify(new URL("../src/adapters/local/profile.mjs", import.meta.url).href)}; console.log(JSON.stringify(loadProfile(process.argv[1]).config.workspace));`;
  const actual = JSON.parse(
    execFileSync(process.execPath, ["--input-type=module", "-e", script, profile.path], {
      cwd: outer.path,
      encoding: "utf8",
    }),
  );
  assert.equal(actual, materials);
  writeFileSync(join(profile.path, "profile.json"), JSON.stringify({ ...profile.config, workspace: "../materials" }));
  assert.throws(() => loadProfile(profile.path), /must be absolute/);
});

test("legacy phase-1 database migrates without discarding work, memory or input identities", (t) => {
  const profile = profileFor(t),
    db = new DatabaseSync(join(profile.path, "assistant.sqlite"));
  db.exec(readFileSync(join(root, "src/adapters/sqlite/schema.sql"), "utf8"));
  db.exec("PRAGMA user_version=1");
  db.prepare("INSERT INTO work VALUES(?,?,1,?,?,?,?,?,?,NULL)").run(
    "legacy-work",
    "preserved",
    "queued",
    "local",
    null,
    null,
    1,
    1,
  );
  db.prepare("INSERT INTO memory VALUES(?,?,1,?,0)").run("city", "上海", "old-memory");
  db.prepare("INSERT INTO input VALUES(?,?,?,?,NULL)").run(
    "old-input",
    '{"op":"submit","params":{"text":"preserved"}}',
    '{"workId":"legacy-work"}',
    1,
  );
  db.close();
  const store = new Store(profile);
  t.after(() => store.close());
  assert.equal(store.db.prepare("PRAGMA user_version").get().user_version, 21);
  assert.equal(store.work("legacy-work").text, "preserved");
  assert.equal(store.memories()[0].value, "上海");
  assert.equal(store.submit("old-input", { text: "preserved" }).duplicate, true);
  const scope = store.app.scope.forWork(store.work("legacy-work")).toJSON();
  assert.deepEqual(scope.resources, []);
  assert.ok(!scope.tools.includes("read_material"));
});

test("a delegation preserves actor and exact resource binding across goal amendments", (t) => {
  const profile = profileFor(t),
    assistant = new Assistant(profile.config);
  const policy = new ScopePolicy(assistant, [{ id: "materials", binding: "root-a" }]);
  const work = {
    delegation_json: JSON.stringify(policy.delegate("original-input")),
  };
  policy.check(work, "read_material", { id: "materials", binding: "root-a" });
  assert.throws(
    () =>
      policy.check(work, "read_material", {
        id: "materials",
        binding: "root-b",
      }),
    /outside/,
  );
  const changed = new ScopePolicy(assistant, [{ id: "materials", binding: "root-b" }]);
  assert.throws(
    () =>
      changed.check(work, "read_material", {
        id: "materials",
        binding: "root-a",
      }),
    /changed/,
  );
  const stranger = new ScopePolicy(new Assistant({ assistantId: "other", owner: "another-user" }), []);
  assert.throws(() => stranger.check(work, "publish_note"), /another assistant or owner/);
});

test("read-only materials reject traversal, absolute paths, symlinks and oversized files", (t) => {
  const profile = profileFor(t),
    directory = join(profile.path, "materials");
  mkdirSync(directory);
  writeFileSync(join(directory, "notes.md"), "真实资料：本周完成接待与执行边界拆分。");
  writeFileSync(join(profile.path, "outside.md"), "outside");
  symlinkSync(join(profile.path, "outside.md"), join(directory, "link.md"));
  writeFileSync(join(directory, "large.txt"), "x".repeat(65537));
  const source = new DirectoryKnowledgeSource(directory);
  assert.match(source.read("notes.md").text, /真实资料/);
  assert.equal(
    source.list().some((f) => f.path === "link.md"),
    false,
  );
  assert.throws(() => source.read("../outside.md"), /scope/);
  assert.throws(() => source.read(join(profile.path, "outside.md")), /relative/);
  assert.throws(() => source.read("link.md"), /symlink/);
  assert.throws(() => source.read("large.txt"), /64 KiB/);
});

test("synchronous transactions reject async callbacks and roll back partially applied commands", (t) => {
  const store = new Store(profileFor(t));
  t.after(() => store.close());
  assert.throws(
    () =>
      store.tx(() => {
        store.app.r.memories.save({
          key: "partial",
          value: "no",
          revision: 1,
          input_id: "bad",
          deleted: 0,
        });
        return Promise.resolve();
      }),
    /Async work/,
  );
  assert.deepEqual(store.memories(), []);
});

test("phase-2 data upgrades to Interaction schema without expanding an existing grant", (t) => {
  const profile = profileFor(t);
  const initial = new Store(profile);
  const original = initial.submit("phase2-input", {
    text: "preserved phase2 goal",
  });
  const grant = JSON.stringify({
    actor: profile.config.owner,
    assistantId: profile.config.assistantId,
    inputId: "phase2-input",
    tools: ["work_context", "publish_note"],
    resources: [],
  });
  initial.db.prepare("UPDATE work SET delegation_json=? WHERE id=?").run(grant, original.workId);
  legacyMemoryFixture(profile, initial.db);
  initial.db.exec(
    "DROP TABLE IF EXISTS execution_native_receipt; ALTER TABLE execution DROP COLUMN harness; DROP TABLE memory_tombstone; DROP TABLE memory_refresh; DROP TABLE memory_learning_control; ALTER TABLE memory_learning DROP COLUMN batch_ids_json; ALTER TABLE memory_learning DROP COLUMN temporal; ALTER TABLE memory_learning DROP COLUMN today; DROP TABLE memory_detail; ALTER TABLE routine DROP COLUMN schedule_json; ALTER TABLE routine DROP COLUMN last_scheduled_at; ALTER TABLE routine DROP COLUMN stop_when; DROP TABLE usage_observation; ALTER TABLE execution DROP COLUMN guard_json; DROP TABLE execution_report; ALTER TABLE execution DROP COLUMN request_json; ALTER TABLE reception DROP COLUMN source_json; ALTER TABLE reception DROP COLUMN attempts; ALTER TABLE reception DROP COLUMN next_at; ALTER TABLE delivery DROP COLUMN message_text; ALTER TABLE delivery DROP COLUMN suppress_notification; ALTER TABLE routine DROP COLUMN resources_json; ALTER TABLE work DROP COLUMN origin_json; ALTER TABLE routine DROP COLUMN notify; DROP TABLE trigger_rule; DROP TABLE assistant_event; DROP TABLE trigger_occurrence; DROP TABLE file_observation; DROP TABLE notification; ALTER TABLE reception DROP COLUMN query_scope_json; DROP TABLE completion_assessment; DROP TABLE completion_evidence; ALTER TABLE work DROP COLUMN completion_json; DROP TABLE interaction; PRAGMA user_version=2;",
  );
  initial.close();
  const migrated = new Store(profile);
  t.after(() => migrated.close());
  assert.equal(migrated.db.prepare("PRAGMA user_version").get().user_version, 21);
  assert.equal(migrated.work(original.workId).delegation_json, grant);
  assert.equal(migrated.submit("phase2-input", { text: "preserved phase2 goal" }).duplicate, true);
  assert.equal(migrated.app.scope.forWork(migrated.work(original.workId)).toJSON().tools.includes("ask_user"), false);
  assert.deepEqual(migrated.app.interactions.list(), []);
});
