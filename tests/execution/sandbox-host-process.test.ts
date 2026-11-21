import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createSandboxPool,
  FULL_SANDBOX_ENFORCEMENT,
  type SandboxBackend,
  type SandboxEnforcement,
  type SandboxPoolPolicy,
} from "../../packages/sandbox/src/index.ts";
import { HOST_PROCESS_ENFORCEMENT, hostProcessSandboxBackend } from "../../packages/sandbox-node/src/host-process.ts";
import { configuredSandboxPool, parseSandboxRuntimeConfiguration } from "../../packages/sandbox-node/src/runtime.ts";

const capacity = { cpuMillis: 4000, memoryBytes: 8 * 1024 ** 3 };
const accepting: SandboxPoolPolicy = {
  id: "host",
  capacity,
  accept: { unenforcedResources: true, bestEffortContainment: true },
};
const posix = process.platform !== "win32";

function fakeBackend(enforcement?: SandboxEnforcement) {
  const closed: string[] = [];
  const backend: SandboxBackend = {
    id: "fake",
    async initialize() {},
    async close() {},
    async create(identity, resources) {
      return {
        resources,
        ...(enforcement ? { enforcement } : {}),
        capabilities: { terminal: false },
        async spawn() {
          throw Error("unused");
        },
        async close() {
          closed.push(identity.id);
        },
      };
    },
  };
  return { backend, closed };
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function until(check: () => boolean, ms = 5000) {
  for (const deadline = Date.now() + ms; Date.now() < deadline; await new Promise((r) => setTimeout(r, 25)))
    if (check()) return;
  assert.fail("condition not reached");
}
function withState(run: (directory: string) => Promise<void>) {
  return async () => {
    const directory = mkdtempSync(join(tmpdir(), "opencraft-host-process-"));
    try {
      await run(join(directory, "state"));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  };
}
const hostPool = (stateDirectory: string, grace = 200) =>
  createSandboxPool(accepting, hostProcessSandboxBackend({ stateDirectory, terminateGraceMs: grace }));
const pids = (text: string) => text.trim().split(/\s+/u).map(Number);

test("a weaker guarantee is refused unless the pool explicitly accepts it", async () => {
  const strict = fakeBackend(HOST_PROCESS_ENFORCEMENT),
    strictPool = await createSandboxPool({ id: "strict", capacity }, strict.backend);
  try {
    await assert.rejects(
      strictPool.createSandbox({ owner: "a" }),
      (error: Error & { code?: string }) => error.code === "SANDBOX_POLICY" && /guarantees less/u.test(error.message),
    );
    assert.equal(strict.closed.length, 1, "the refused environment is reclaimed");
    // Capacity came back: a second full-size request is admitted to the backend again.
    await assert.rejects(strictPool.createSandbox({ owner: "b" }), /guarantees less/u);
  } finally {
    await strictPool.close();
  }

  const partial = fakeBackend(HOST_PROCESS_ENFORCEMENT);
  const partialPool = await createSandboxPool(
    { id: "partial", capacity, accept: { unenforcedResources: true } },
    partial.backend,
  );
  try {
    await assert.rejects(partialPool.createSandbox({ owner: "a" }), /guarantees less/u);
  } finally {
    await partialPool.close();
  }

  const accepted = fakeBackend(HOST_PROCESS_ENFORCEMENT),
    acceptedPool = await createSandboxPool(accepting, accepted.backend);
  try {
    const sandbox = await acceptedPool.createSandbox({ owner: "a" });
    assert.deepEqual(sandbox.enforcement, HOST_PROCESS_ENFORCEMENT);
    await sandbox.close();
  } finally {
    await acceptedPool.close();
  }
});

test("an environment that states nothing keeps the full guarantee, and invalid statements are refused", async () => {
  const full = fakeBackend(),
    pool = await createSandboxPool({ id: "full", capacity }, full.backend);
  try {
    const sandbox = await pool.createSandbox({ owner: "a" });
    assert.deepEqual(sandbox.enforcement, FULL_SANDBOX_ENFORCEMENT);
    await sandbox.close();
  } finally {
    await pool.close();
  }
  const bogus = fakeBackend({ resources: "partly", containment: "complete" } as unknown as SandboxEnforcement);
  const bogusPool = await createSandboxPool(accepting, bogus.backend);
  try {
    await assert.rejects(bogusPool.createSandbox({ owner: "a" }), /invalid effective constraints/u);
  } finally {
    await bogusPool.close();
  }
  await assert.rejects(
    createSandboxPool({ id: "x", capacity, accept: { everything: true } as never }, full.backend),
    /Invalid sandbox pool policy/u,
  );
});

test(
  "a host-process configuration must accept its weaker guarantee explicitly",
  withState(async (directory) => {
    const config = (accept?: unknown) => ({
      schemaVersion: 1,
      backend: { id: "host-process", options: { stateDirectory: directory } },
      pool: { idPrefix: "desktop", ...(accept ? { accept } : {}) },
      environment: { mode: "local-inherit" },
    });
    assert.throws(() => parseSandboxRuntimeConfiguration(config()), /configuration is invalid/u);
    assert.throws(
      () => parseSandboxRuntimeConfiguration(config({ unenforcedResources: true })),
      /configuration is invalid/u,
    );
    const pool = await configuredSandboxPool(
      parseSandboxRuntimeConfiguration(config({ unenforcedResources: true, bestEffortContainment: true })),
    );
    try {
      const sandbox = await pool.createSandbox({ owner: "a" });
      assert.equal(sandbox.identity.backend, "host-process");
      assert.deepEqual(sandbox.enforcement, HOST_PROCESS_ENFORCEMENT);
      await sandbox.close();
    } finally {
      await pool.close();
    }
  }),
);

test(
  "commands get exactly the selected environment and cwd",
  { skip: !posix },
  withState(async (directory) => {
    const pool = await hostPool(directory);
    try {
      const sandbox = await pool.createSandbox({ owner: "a" });
      let text = "";
      const child = await sandbox.spawn({ command: ["/usr/bin/env"], cwd: "/tmp", env: { ONLY: "this" } }, (e) => {
        text += Buffer.from(e.data).toString();
      });
      assert.equal((await child.exited).code, 0);
      assert.deepEqual(
        text
          .trim()
          .split("\n")
          .filter((line) => !line.startsWith("PWD=")),
        ["ONLY=this"],
      );
      await sandbox.close();
    } finally {
      await pool.close();
    }
  }),
);

test(
  "closing reclaims the command's whole process group, children included",
  { skip: !posix },
  withState(async (directory) => {
    const pool = await hostPool(directory);
    try {
      const sandbox = await pool.createSandbox({ owner: "a" });
      let text = "";
      const child = await sandbox.spawn(
        { command: ["/bin/sh", "-c", "sleep 300 & echo $!; sleep 300 & echo $!; wait"], cwd: "/", env: {} },
        (e) => {
          text += Buffer.from(e.data).toString();
        },
      );
      await until(() => pids(text).length === 2 && pids(text).every(Boolean));
      const descendants = pids(text);
      assert.ok(descendants.every(alive));
      await sandbox.close();
      assert.ok(
        descendants.every((pid) => !alive(pid)),
        "every descendant is gone after close",
      );
      assert.ok((await child.exited).signal || (await child.exited).code !== 0);
    } finally {
      await pool.close();
    }
  }),
);

test(
  "a finished command takes what it left running with it",
  { skip: !posix },
  withState(async (directory) => {
    const pool = await hostPool(directory);
    try {
      const sandbox = await pool.createSandbox({ owner: "a" });
      let text = "";
      const child = await sandbox.spawn(
        { command: ["/bin/sh", "-c", "sleep 300 & echo $!"], cwd: "/", env: {} },
        (e) => {
          text += Buffer.from(e.data).toString();
        },
      );
      assert.equal((await child.exited).code, 0);
      assert.equal(alive(pids(text)[0]!), false);
      await sandbox.close();
    } finally {
      await pool.close();
    }
  }),
);

test(
  "a descendant that starts its own session escapes: the guarantee is best-effort, as stated",
  { skip: !posix },
  withState(async (directory) => {
    const pool = await hostPool(directory);
    let escaped = 0;
    try {
      const sandbox = await pool.createSandbox({ owner: "a" });
      assert.equal(sandbox.enforcement.containment, "best-effort");
      let text = "";
      await sandbox.spawn(
        { command: ["/bin/sh", "-c", "setsid /bin/sh -c 'echo $$; exec sleep 300' & sleep 300"], cwd: "/", env: {} },
        (e) => {
          text += Buffer.from(e.data).toString();
        },
      );
      await until(() => pids(text)[0]! > 0);
      escaped = pids(text)[0]!;
      await sandbox.close();
      assert.equal(alive(escaped), true);
    } finally {
      if (escaped)
        try {
          process.kill(escaped, "SIGKILL");
        } catch {}
      await pool.close();
    }
  }),
);

test(
  "terminal commands run in a pseudo-terminal and are reclaimed the same way",
  { skip: !posix },
  withState(async (directory) => {
    const pool = await hostPool(directory);
    try {
      const sandbox = await pool.createSandbox({ owner: "a" });
      let text = "";
      const child = await sandbox.spawn(
        {
          command: ["/bin/sh", "-c", "[ -t 0 ] && echo tty; sleep 300"],
          cwd: "/",
          env: {},
          terminal: { cols: 80, rows: 24 },
        },
        (e) => {
          text += Buffer.from(e.data).toString();
        },
      );
      assert.equal(child.kind, "terminal");
      await until(() => text.includes("tty"));
      await sandbox.close();
      await child.exited;
    } finally {
      await pool.close();
    }
  }),
);

test(
  "after an owner crash the next owner reclaims what it left, and a live owner is never taken over",
  { skip: !posix },
  withState(async (directory) => {
    const owner = spawn(
      process.execPath,
      ["--import", "tsx", join(import.meta.dirname, "fixtures/host-process-owner.ts"), directory],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    let text = "";
    owner.stdout.on("data", (data) => {
      text += data;
    });
    try {
      await until(() => pids(text)[0]! > 0, 20_000);
      const leftover = pids(text)[0]!;
      assert.ok(alive(leftover));
      // While the first owner lives, its state is not taken over.
      const contender = await hostPool(directory);
      await assert.rejects(contender.createSandbox({ owner: "b" }), /could not initialize/u);
      await contender.close();

      owner.kill("SIGKILL");
      await new Promise((resolve) => owner.once("exit", resolve));
      assert.ok(alive(leftover), "a crashed owner leaves its command running");
      const successor = await hostPool(directory);
      try {
        const sandbox = await successor.createSandbox({ owner: "c" });
        assert.equal(alive(leftover), false, "the successor reclaimed the leftover group before admitting work");
        await sandbox.close();
      } finally {
        await successor.close();
      }
    } finally {
      if (owner.exitCode === null) owner.kill("SIGKILL");
    }
  }),
);
