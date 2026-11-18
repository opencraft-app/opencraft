// Preloaded into every node:test file process. CI enables it with
//   NODE_OPTIONS="--import <this file> --test-global-setup=<test-isolation-global.mjs>"
//
// Each test file process gets a private HOME and TMPDIR, so no test reads or
// writes the developer's real ~/.opencraft. Processes it spawns inherit a
// marker naming the run and the test file; the global teardown reports any of
// them that are still alive after every test file has exited. Non-test Node
// processes (npm, tsc, the test runner itself) are untouched.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

export const MARKER = "OPENCRAFT_TEST_ISOLATION";
export const RUN = "OPENCRAFT_TEST_RUN";

if (process.env.NODE_TEST_CONTEXT && !process.env[MARKER]) {
  const root = mkdtempSync(join(tmpdir(), "opencraft-test-"));
  const home = join(root, "home");
  const temp = join(root, "tmp");
  mkdirSync(home);
  mkdirSync(temp);
  const file = process.argv[1] ? relative(process.cwd(), process.argv[1]) : "unknown";
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
}
