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
let reported = false;
await sandbox.spawn({ command: ["/bin/sh", "-c", "sleep 300 & echo $!; sleep 300"], cwd: "/", env: {} }, (event) => {
  if (!reported) {
    reported = true;
    process.stdout.write(Buffer.from(event.data).toString());
  }
});
setInterval(() => {}, 1000);
