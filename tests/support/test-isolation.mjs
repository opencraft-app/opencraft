// Preloaded into every node:test file process. CI enables it with
//   NODE_OPTIONS="--import <this file> --test-global-setup=<test-isolation-global.mjs>"
//
// Each test file process gets a private HOME and TMPDIR, so no test reads or
// writes the developer's real ~/.opencraft or sees their git configuration. Processes it spawns inherit a
// marker naming the run and the test file; the global teardown reports any of
// them that are still alive after every test file has exited. A test file
// process that outlives its budget fails with the resources still holding it.
// Non-test Node processes (npm, tsc, the test runner itself) are untouched.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";

export const MARKER = "OPENCRAFT_TEST_ISOLATION";
export const RUN = "OPENCRAFT_TEST_RUN";
export const FILE_BUDGET = "OPENCRAFT_TEST_FILE_BUDGET_MS";
const DEFAULT_FILE_BUDGET_MS = 300_000;

if (process.env.NODE_TEST_CONTEXT && !process.env[MARKER]) {
  const root = mkdtempSync(join(tmpdir(), "opencraft-test-"));
  const home = join(root, "home");
  const temp = join(root, "tmp");
  mkdirSync(home);
  mkdirSync(temp);
  const file = process.argv[1] ? relative(process.cwd(), process.argv[1]) : "unknown";
  // Git configuration injected through the environment (as cloud sessions do
  // for their GitHub proxy) is host state like ~/.gitconfig; tests must not see it.
  for (const name of Object.keys(process.env)) {
    if (/^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+|PARAMETERS|GLOBAL|SYSTEM)$/u.test(name)) delete process.env[name];
  }
  // Installed browsers are host tooling, not user state: keep Playwright's
  // default cache (under the real HOME) reachable once HOME is replaced.
  if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
    const cache =
      process.platform === "darwin"
        ? join(homedir(), "Library", "Caches")
        : process.platform === "win32"
          ? (process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"))
          : (process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"));
    process.env.PLAYWRIGHT_BROWSERS_PATH = join(cache, "ms-playwright");
  }
  Object.assign(process.env, {
    HOME: home,
    USERPROFILE: home,
    TMPDIR: temp,
    TMP: temp,
    TEMP: temp,
    [MARKER]: `${process.env[RUN] ?? "solo"}|${file}`,
  });
  process.once("exit", () => {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // A process the teardown stops later may still hold a file; OS temp cleanup covers it.
    }
  });
  watchFileBudget(file);
}

/**
 * A test file process that outlives its budget, whether a test never settles or
 * a handle keeps the loop alive after the last test, fails here with its name
 * and the resources still holding it. Without this the runner waits silently
 * until the CI step times out and the log cannot say which file hung. The timer
 * is unref'd, so it never keeps a finished file alive.
 */
function watchFileBudget(file) {
  const budget = fileBudgetMs(process.env[FILE_BUDGET]);
  if (budget === 0) return;
  setTimeout(() => {
    const active = new Map();
    for (const resource of process.getActiveResourcesInfo()) active.set(resource, (active.get(resource) ?? 0) + 1);
    const summary = [...active].map(([resource, count]) => (count > 1 ? `${resource} x${count}` : resource)).join(", ");
    process.stderr.write(
      `\n[test-isolation] ${file} did not exit within ${budget / 1000}s (${FILE_BUDGET}); still active: ${summary || "nothing reported"}\n`,
    );
    process.exit(1);
  }, budget).unref();
}

/** Milliseconds a test file process may live; 0 disables the watchdog. */
export function fileBudgetMs(value) {
  if (value === undefined || value === "") return DEFAULT_FILE_BUDGET_MS;
  if (!/^\d+$/u.test(value)) throw new Error(`${FILE_BUDGET} must be a whole number of milliseconds`);
  return Number(value);
}
