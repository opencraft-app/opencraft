#!/usr/bin/env node
// A process that serves connections must not block its event loop with
// synchronous IO (AGENTS.md "网络主线程不得阻塞"). This check finds the source
// each network process loads on its main thread, by following imports from
// the process entries in config/main-thread-sync-io.json, and counts the
// synchronous file, process and SQLite calls in it, plus the SQL statements it
// prepares or executes (each one runs synchronously in SQLite on that thread). Worker modules start from
// a URL, not an import, so code that runs only in a Worker is not reached.
//
// Existing calls are recorded per file in the same config and may only
// shrink: move the work to a Worker or an async API, then run with --update.
import { readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const configPath = "config/main-thread-sync-io.json";

/** Synchronous calls that block the event loop on disk, a child process or SQLite. */
export const BLOCKING_CALLS = Object.freeze([
  "DatabaseSync",
  "execSync",
  "execFileSync",
  "spawnSync",
  ...[
    "access",
    "appendFile",
    "chmod",
    "chown",
    "close",
    "copyFile",
    "cp",
    "exists",
    "fstat",
    "fsync",
    "ftruncate",
    "lstat",
    "mkdir",
    "mkdtemp",
    "open",
    "read",
    "readdir",
    "readFile",
    "readlink",
    "realpath",
    "rename",
    "rm",
    "rmdir",
    "stat",
    "symlink",
    "truncate",
    "unlink",
    "utimes",
    "write",
    "writeFile",
  ].map((name) => `${name}Sync`),
]);

const callPattern = new RegExp(`(?<![\\w$])(${BLOCKING_CALLS.join("|")})(?![\\w$])`, "g");

/** Source without comments, string contents kept so offsets stay meaningful enough for counting. */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
}

/** Counts each blocking call in a module, ignoring import and require lines that only name it. */
export function countBlockingCalls(text) {
  const counts = {};
  for (const line of stripComments(text).split("\n")) {
    if (
      /^\s*(import\b|export\s+\{[^}]*\}\s+from\b)/.test(line) ||
      /^\s*(const|let|var)\s*\{[^}]*\}\s*=\s*require\s*\([^)]*\)\s*;?\s*$/.test(line)
    )
      continue;
    for (const [, name] of line.matchAll(callPattern)) counts[name] = (counts[name] ?? 0) + 1;
  }
  const statements = countSqlStatements(text);
  if (statements) counts[SQL_STATEMENT] = statements;
  return counts;
}

/** Recorded name for SQL run through a connection the module holds on its thread. */
export const SQL_STATEMENT = "SQL statement";

const sqlPattern = new RegExp(
  "\\.(?:prepare|exec)\\s*\\(\\s*[`'\"]\\s*(?:" +
    "SELECT|INSERT|UPDATE|DELETE|REPLACE|WITH|PRAGMA|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|" +
    "CREATE|ALTER|DROP|VACUUM|ATTACH|DETACH|ANALYZE|REINDEX" +
    ")\\b",
  "gi",
);

/**
 * Counts SQL text handed to `.prepare(` or `.exec(` as a literal. Each one is a
 * synchronous round trip into SQLite on this thread, so new statements are
 * debt like new sync calls. SQL built in a variable is not seen.
 */
export function countSqlStatements(text) {
  return [...stripComments(text).matchAll(sqlPattern)].length;
}

const loaders = Object.fromEntries(
  [".css", ".scss", ".svg", ".png", ".jpg", ".woff2", ".wasm", ".node", ".py", ".sh", ".html", ".md"].map(
    (extension) => [extension, "empty"],
  ),
);

/** Workspace packages are followed into their source; every other package is outside OpenCraft's code. */
const followWorkspace = {
  name: "follow-workspace",
  setup(context) {
    context.onResolve({ filter: /^[^./]/ }, (args) =>
      args.path.startsWith("@opencraft/") ? undefined : { path: args.path, external: true },
    );
  },
};

/** Repository-relative source files a process entry loads on its main thread. */
export async function mainThreadModules(entry, { root = repositoryRoot } = {}) {
  const result = await build({
    absWorkingDir: root,
    entryPoints: [entry],
    bundle: true,
    write: false,
    metafile: true,
    platform: "node",
    format: "esm",
    logLevel: "silent",
    loader: { ...loaders, ".sql": "text", ".json": "json" },
    plugins: [followWorkspace],
  });
  return Object.keys(result.metafile.inputs)
    .map((input) => relative(root, resolve(root, input)))
    .filter((file) => !file.startsWith("..") && !file.includes("node_modules/") && /\.(c|m)?[jt]sx?$/.test(file));
}

export async function scan(entries, { root = repositoryRoot } = {}) {
  const modules = new Set();
  for (const entry of entries) for (const file of await mainThreadModules(entry, { root })) modules.add(file);
  const files = {};
  for (const file of [...modules].sort()) {
    const counts = countBlockingCalls(await readFile(resolve(root, file), "utf8"));
    if (Object.keys(counts).length)
      files[file] = Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
  }
  return files;
}

/** Calls above the recorded count (growth) and recorded calls that are gone (stale). */
export function compare(recorded, current) {
  const growth = [];
  const stale = [];
  for (const [file, counts] of Object.entries(current))
    for (const [name, count] of Object.entries(counts)) {
      const allowed = recorded[file]?.[name] ?? 0;
      if (count > allowed) growth.push(`${file}: ${name} ×${count} (recorded ${allowed})`);
    }
  for (const [file, counts] of Object.entries(recorded))
    for (const [name, count] of Object.entries(counts)) {
      const now = current[file]?.[name] ?? 0;
      if (now < count) stale.push(`${file}: ${name} ×${now} (recorded ${count})`);
    }
  return { growth, stale };
}

async function main() {
  const root = repositoryRoot;
  const update = process.argv.includes("--update");
  const config = JSON.parse(await readFile(resolve(root, configPath), "utf8"));
  const current = await scan(config.entries);
  const { growth, stale } = compare(config.files, current);
  if (growth.length) {
    console.error(
      `Synchronous IO added to code that network processes run on their main thread.\n` +
        `Use an async API or move the work into a Worker with an explicit lifecycle (AGENTS.md).\n\n` +
        growth.map((line) => `  ${line}`).join("\n"),
    );
    process.exit(1);
  }
  if (update) {
    await writeFile(resolve(root, configPath), `${JSON.stringify({ ...config, files: current }, null, 2)}\n`);
    console.log(`Recorded ${stale.length} removed synchronous call site(s) in ${configPath}.`);
    return;
  }
  if (stale.length) {
    console.error(
      `${configPath} records synchronous calls that are gone. Run \`node scripts/check/check-main-thread-sync-io.mjs --update\` to shrink it.\n\n` +
        stale.map((line) => `  ${line}`).join("\n"),
    );
    process.exit(1);
  }
  let sites = 0;
  let statements = 0;
  for (const counts of Object.values(current))
    for (const [name, count] of Object.entries(counts))
      if (name === SQL_STATEMENT) statements += count;
      else sites += count;
  console.log(
    `Main-thread synchronous IO: ${sites} recorded call(s) and ${statements} SQL statement(s) in ${Object.keys(current).length} file(s); none added.`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
