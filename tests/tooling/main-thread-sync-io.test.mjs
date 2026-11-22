import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  compare,
  countBlockingCalls,
  countSqlStatements,
  mainThreadModules,
  scan,
} from "../../scripts/check/check-main-thread-sync-io.mjs";

test("counts blocking calls, not the imports or comments that name them", () => {
  const counts = countBlockingCalls(
    [
      'import { readFileSync, writeFileSync } from "node:fs";',
      'import { DatabaseSync } from "node:sqlite";',
      'const { execSync } = require("node:child_process");',
      'const probe = () => require("node:fs").statSync(p);',
      "// readFileSync(old) used to run here",
      "/* execSync(cleanup) */",
      'const db = new DatabaseSync(path); readFileSync(a, "utf8");',
      "function save(db: DatabaseSync) { writeFileSync(b, data); }",
      "await readFile(c); flushSync(render); existsSyncCache.get(d);",
    ].join("\n"),
  );
  assert.deepEqual(counts, { DatabaseSync: 2, readFileSync: 1, statSync: 1, writeFileSync: 1 });
});

test("only growth beyond the record fails; removed calls must shrink the record", () => {
  const recorded = { "a.ts": { readFileSync: 2 }, "b.ts": { execSync: 1 } };
  assert.deepEqual(compare(recorded, { "a.ts": { readFileSync: 2 }, "b.ts": { execSync: 1 } }), {
    growth: [],
    stale: [],
  });
  const { growth, stale } = compare(recorded, { "a.ts": { readFileSync: 3 }, "c.ts": { DatabaseSync: 1 } });
  assert.deepEqual(growth, ["a.ts: readFileSync ×3 (recorded 2)", "c.ts: DatabaseSync ×1 (recorded 0)"]);
  assert.deepEqual(stale, ["b.ts: execSync ×0 (recorded 1)"]);
});

test("counts SQL statements prepared or executed as literals, not other prepare/exec calls", () => {
  const text = [
    'const row = db.prepare("SELECT * FROM actors WHERE id = ?").get(id);',
    "this.#db.prepare(",
    "  `INSERT INTO members (id) VALUES (?)`,",
    ").run(id);",
    'database.exec("BEGIN IMMEDIATE"); database.exec(`commit`);',
    '// db.prepare("DELETE FROM gone")',
    "session.prepare(frame); admissionPolicy.prepare(identity);",
    '/^a/.exec("abc"); db.prepare(sql); pattern.exec("selected");',
  ].join("\n");
  assert.equal(countSqlStatements(text), 4);
  assert.deepEqual(countBlockingCalls(text), { "SQL statement": 4 });
});

// A Worker starts from a URL, so its module (and what only it imports) never
// joins the main thread's import graph, while a dynamic import does.
test("follows imports from a process entry but not into Workers it starts", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "main-thread-io-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "src"));
  const files = {
    "src/main.mjs": [
      'import { Worker } from "node:worker_threads";',
      'import { load } from "./config.mjs";',
      'new Worker(new URL("./store.worker.mjs", import.meta.url));',
      'export const later = () => import("./lazy.mjs");',
      "load();",
    ].join("\n"),
    "src/config.mjs": 'import { readFileSync } from "node:fs";\nexport const load = () => readFileSync("a");',
    "src/lazy.mjs": 'import { execFileSync } from "node:child_process";\nexport const run = () => execFileSync("x");',
    "src/store.worker.mjs": 'import { DatabaseSync } from "node:sqlite";\nnew DatabaseSync(":memory:");',
  };
  for (const [file, text] of Object.entries(files)) await writeFile(join(root, file), text);
  assert.deepEqual((await mainThreadModules("src/main.mjs", { root })).sort(), [
    "src/config.mjs",
    "src/lazy.mjs",
    "src/main.mjs",
  ]);
  assert.deepEqual(await scan(["src/main.mjs"], { root }), {
    "src/config.mjs": { readFileSync: 1 },
    "src/lazy.mjs": { execFileSync: 1 },
  });
});
