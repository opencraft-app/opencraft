import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { localSandboxFixture } from "../fixtures/assistant-sandbox";
import { managedSandboxRoundtrip } from "../fixtures/managed-sandbox-roundtrip";
test(
  "native DM -> named Bot -> captured Work -> isolated command -> native result; pause reclaims its environment",
  { timeout: 50000 },
  async (t) => {
    if (
      !existsSync(
        "/opt/opencraft/runtime/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex",
      )
    ) {
      t.skip("Pinned native binary unavailable");
      return;
    }
    const root = await mkdtemp(join(tmpdir(), "bot-remote-fixture-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const f = localSandboxFixture({
      cpuMillis: 8000,
      memoryBytes: 16 * 1024 ** 3,
    });
    const result = await managedSandboxRoundtrip({
      workspaceRoot: root,
      createBackend: () => f.backend(),
    });
    assert.equal(result.passed, true);
    assert.equal(result.toolRequests, 1);
    assert.equal(f.owners.length, 1);
    assert.equal(f.destroyed, 1);
  },
);
test(
  "unknown sandbox effect stays pending across brain restart and is never replayed by a new native call",
  { timeout: 50000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "bot-unknown-fixture-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const f = localSandboxFixture({
      cpuMillis: 8000,
      memoryBytes: 16 * 1024 ** 3,
    });
    let effects = 0;
    const result = await managedSandboxRoundtrip({
      workspaceRoot: root,
      expectUnknown: true,
      createBackend: () => {
        const backend = f.backend(),
          create = backend.create.bind(backend);
        backend.create = async (...args) => {
          const environment = await create(...args),
            spawn = environment.spawn.bind(environment);
          environment.spawn = async (command, output) => {
            if (command.command.some((v) => v.includes("isolated-environment-proof"))) {
              effects++;
              const child = await spawn(command, output);
              if (child.kind === "process") await child.closeStdin();
              await child.exited;
              throw Error("lost provider acknowledgement after an effect");
            }
            return spawn(command, output);
          };
          return environment;
        };
        return backend;
      },
    });
    assert.equal(result.unknownEffectFenced, true);
    assert.equal(effects, 1);
  },
);
