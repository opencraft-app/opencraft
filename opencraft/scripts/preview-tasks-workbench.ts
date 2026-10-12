import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { startHeadlessServer } from "./headless-server.mjs";

// Full production Workbench + actual DSH/Codex engines, with independent data.
// Build using OPENCRAFT_HEADLESS_SERVER_BUILD and the headless Host definition.
const root = process.cwd();
const dataDirectory = process.env.OPENCRAFT_TASKS_WORKBENCH_DATA
  ? resolve(process.env.OPENCRAFT_TASKS_WORKBENCH_DATA)
  : await mkdtemp(join(tmpdir(), "opencraft-tasks-workbench-"));
const server = await startHeadlessServer({
  root,
  webRoot: join(root, "apps/workbench-web/dist"),
  dataDirectory,
  dshCapabilityPlugin: join(root, "apps/local-agent-host/src/dsh-capability-plugin.mjs"),
  codexExecutable: process.env.OPENCRAFT_CODEX_EXECUTABLE ?? "codex",
  port: Number(process.env.OPENCRAFT_TASKS_WORKBENCH_PORT ?? 0),
});
console.log(`OpenCraft Workbench: ${server.url}`);
console.log(`Workbench data: ${dataDirectory}`);
console.log("Real Workbench, engine thread catalog/navigation and backend SQLite. No fixture conversation adapter.");
let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  await server.close();
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
