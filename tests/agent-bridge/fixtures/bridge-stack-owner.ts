// Stands in for the daemon: starts the bridge stack and reports its children.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { startCodexBridgeStack } from "../../../apps/opencraft-daemon/src/codex-bridge-stack.js";

const [programs, root] = process.argv.slice(2) as [string, string];
const stack = await startCodexBridgeStack({
  programs,
  node: process.execPath,
  codexExecutable: "/unused",
  codexDataDirectory: join(root, "codex"),
  nativeCodexHomeDirectory: join(root, "native"),
  runtimeDirectory: root,
  stateDirectory: join(root, "state"),
  authToken: "synthetic-stack-lifecycle-token-".repeat(2),
  startupTimeoutMs: 15_000,
  log: () => {},
});
const children = JSON.parse(await readFile(join(root, "state/children.json"), "utf8")).map(
  (row: { pid: number }) => row.pid,
);
// Handle SIGTERM before reporting: the test may signal as soon as it reads the report.
process.once("SIGTERM", () => void stack.close().then(() => process.exit(0)));
process.stdout.write(`${JSON.stringify({ children, url: stack.bridge.url })}\n`);
