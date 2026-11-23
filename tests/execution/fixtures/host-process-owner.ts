// A sandbox owner that starts one long command, reports its PID and then waits to be killed.
import { createSandboxPool } from "../../../packages/sandbox/src/index.ts";
import { hostProcessSandboxBackend } from "../../../packages/sandbox-node/src/host-process.ts";

const pool = await createSandboxPool(
  {
    id: "crash",
    capacity: { cpuMillis: 4000, memoryBytes: 8 * 1024 ** 3 },
    accept: { unenforcedResources: true, bestEffortContainment: true },
  },
  hostProcessSandboxBackend({ stateDirectory: process.argv[2]! }),
);
const sandbox = await pool.createSandbox({ owner: "crash-test" });
let first = "";
let report: () => void = () => {};
const reported = new Promise<void>((resolve) => (report = resolve));
await sandbox.spawn({ command: ["/bin/sh", "-c", "sleep 300 & echo $!; sleep 300"], cwd: "/", env: {} }, (event) => {
  if (!first) {
    first = Buffer.from(event.data).toString();
    report();
  }
});
// Output can arrive before spawn resolves; report only once the backend has recorded the command for recovery.
await reported;
process.stdout.write(first);
setInterval(() => {}, 1000);
