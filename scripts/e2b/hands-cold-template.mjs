import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  connection,
  exclusiveOperation,
  loadPlan,
  readPrivate,
  saveReceipt,
  templateDefinition,
} from "./hands-template.mjs";

// Execute exactly the same adaptation commands as the fromImage builder. The
// operator seed must already contain that immutable image and E2B's guest agent.
export function preparationCommands(plan) {
  const steps = [];
  let user = "root",
    cwd = "/",
    envs = {};
  const recorder = {
    fromImage() {
      return this;
    },
    setUser(value) {
      user = value;
      return this;
    },
    setWorkdir(value) {
      cwd = value;
      return this;
    },
    setEnvs(value) {
      envs = { ...envs, ...value };
      return this;
    },
    runCmd(command) {
      steps.push({ command, user, cwd, envs: { ...envs } });
      return this;
    },
  };
  templateDefinition(() => recorder, plan);
  return steps;
}
export function validateSeed(seed, plan) {
  assert.equal(seed.schemaVersion, 1);
  assert.equal(seed.phase, "ready");
  assert.equal(seed.image, plan.image, "Seed must be derived from the planned immutable image");
  assert.equal(seed.cpuCount, plan.cpuCount);
  assert.equal(seed.memoryMB, plan.memoryMB);
  assert.equal(seed.filesystemOnly, true);
  assert.ok(seed.captureMode === undefined || seed.captureMode === "memory", "Unsupported operator capture mode");
  assert.match(seed.seedTemplateId, /^[a-zA-Z0-9-]{8,64}$/);
  assert.match(seed.sourceArtifactId, /^[a-f0-9-]{36}$/);
  for (const field of ["rootfsSha256", "headerSha256", "metadataSha256"]) assert.match(seed[field], /^[a-f0-9]{64}$/);
  if (seed.buildSandboxId) {
    assert.match(seed.buildSandboxId, /^[a-zA-Z0-9-]{8,64}$/);
    assert.equal(seed.buildSandboxPurpose, "hands-cold-template-build");
  }
  if (seed.kernelAdaptation) {
    assert.match(seed.kernelAdaptation.kernel, /^[a-zA-Z0-9._+-]+$/);
    assert.match(seed.kernelAdaptation.archiveSha256, /^[a-f0-9]{64}$/);
    assert.equal(seed.kernelAdaptation.installed, true);
  }
  return seed;
}
export async function buildColdTemplate(directory, credentials, seed, sdk) {
  return exclusiveOperation(directory, async () => {
    const { plan, planSha256 } = await loadPlan(directory);
    validateSeed(seed, plan);
    assert.equal(await sdk.Template.exists(plan.name, credentials.options), false, "Choose an unused snapshot name");
    const file = join(directory, "receipt.json");
    const receipt = {
      schemaVersion: 1,
      method: "filesystem-snapshot",
      planSha256,
      image: plan.image,
      ...(plan.sourceImage ? { sourceImage: plan.sourceImage } : {}),
      name: plan.name,
      phase: seed.buildSandboxId ? "connecting" : "creating",
      createdAt: new Date().toISOString(),
      seed,
      buildSandbox: seed.buildSandboxId
        ? { phase: "connecting", sandboxId: seed.buildSandboxId }
        : { phase: "creating" },
    };
    await writeFile(file, JSON.stringify(receipt, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    const persist = () => saveReceipt(file, receipt);
    let sandbox;
    try {
      sandbox = seed.buildSandboxId
        ? await sdk.Sandbox.connect(seed.buildSandboxId, credentials.options)
        : await sdk.Sandbox.create(seed.seedTemplateId, {
            ...credentials.options,
            timeoutMs: 600000,
            metadata: { "opencraft-purpose": "hands-cold-template-build", "opencraft-plan": planSha256 },
          });
      receipt.buildSandbox = { phase: "preparing", sandboxId: sandbox.sandboxId };
      receipt.phase = "preparing";
      await persist();
      const info = await sandbox.getInfo();
      assert.equal(info.cpuCount, plan.cpuCount);
      assert.equal(info.memoryMB, plan.memoryMB);
      if (seed.buildSandboxId) assert.equal(info.metadata?.["opencraft-purpose"], seed.buildSandboxPurpose);
      for (const [index, { command, ...options }] of preparationCommands(plan).entries()) {
        receipt.buildSandbox.commandIndex = index;
        await persist();
        const result = await sandbox.commands.run(command, { ...options, timeoutMs: 30000 });
        receipt.buildSandbox.commandExitCode = result.exitCode;
        assert.equal(result.exitCode, 0, "Image adaptation failed");
      }
      // A full snapshot can leave recent ext4 writes only in captured RAM.
      // Cold publication discards RAM, so flush the guest filesystem first.
      const flushed = await sandbox.commands.run("sync", { user: "root", cwd: "/", timeoutMs: 30000 });
      assert.equal(flushed.exitCode, 0, "Guest filesystem flush failed");
      receipt.buildSandbox.filesystemFlushed = true;
      receipt.phase = "snapshotting";
      await persist(); // Snapshot acknowledgement can also be lost: never replay it.
      const operatorPublication = seed.captureMode === "memory";
      const result = await sandbox.createSnapshot({
        name: operatorPublication ? plan.name + "-source" : plan.name,
        mode: operatorPublication ? "full" : "filesystem",
        requestTimeoutMs: 180000,
      });
      assert.ok(result.snapshotId);
      if (operatorPublication) {
        receipt.sourceSnapshotId = result.snapshotId;
        receipt.sourceSnapshotNames = result.names;
        receipt.phase = "awaiting-cold-publication";
      } else {
        receipt.snapshotId = result.snapshotId;
        receipt.templateId = result.snapshotId;
        receipt.snapshotNames = result.names;
        receipt.phase = "ready";
      }
      await persist();
    } catch (error) {
      receipt.failedStage = receipt.phase;
      if (Number.isInteger(error?.statusCode)) receipt.httpStatus = error.statusCode;
      receipt.phase = sandbox
        ? receipt.phase === "snapshotting"
          ? "snapshot-unknown"
          : "failed"
        : seed.buildSandboxId
          ? "connection-failed"
          : "creation-unknown";
      throw new Error(
        "Cold template build did not complete; reconcile the receipt before allocating or snapshotting again",
      );
    } finally {
      if (sandbox) {
        receipt.buildSandbox.cleanup = "unknown";
        await persist();
        try {
          await sandbox.kill({ requestTimeoutMs: 30000 }).catch(() => {});
          try {
            await sandbox.getInfo({ requestTimeoutMs: 30000 });
          } catch (error) {
            if (!(error instanceof sdk.SandboxNotFoundError)) throw error;
            receipt.buildSandbox.cleanup = "confirmed";
          }
          assert.equal(receipt.buildSandbox.cleanup, "confirmed", "Build VM deletion not confirmed");
        } finally {
          await persist();
        }
      } else if (seed.buildSandboxId) {
        receipt.buildSandbox.cleanup = "unknown";
        await persist();
        try {
          await sdk.Sandbox.kill(seed.buildSandboxId, credentials.options).catch(() => {});
          try {
            await sdk.Sandbox.getInfo(seed.buildSandboxId, credentials.options);
          } catch (error) {
            if (!(error instanceof sdk.SandboxNotFoundError)) throw error;
            receipt.buildSandbox.cleanup = "confirmed";
          }
          assert.equal(receipt.buildSandbox.cleanup, "confirmed");
        } finally {
          await persist();
        }
      } else await persist();
    }
    return receipt;
  });
}
export async function acceptColdPublication(directory, credentials, publication, sdk) {
  return exclusiveOperation(directory, async () => {
    const { plan, planSha256 } = await loadPlan(directory);
    const file = join(directory, "receipt.json");
    const receipt = JSON.parse(await readPrivate(file));
    assert.equal(receipt.planSha256, planSha256);
    assert.equal(receipt.method, "filesystem-snapshot");
    assert.equal(receipt.phase, "awaiting-cold-publication");
    assert.equal(receipt.buildSandbox.cleanup, "confirmed");
    assert.equal(receipt.buildSandbox.filesystemFlushed, true);
    assert.equal(publication.schemaVersion, 1);
    assert.equal(publication.phase, "ready");
    assert.equal(publication.filesystemOnly, true);
    assert.equal(publication.image, plan.image);
    assert.equal(publication.planSha256, planSha256);
    assert.equal(publication.sourceSnapshotId, receipt.sourceSnapshotId);
    assert.match(publication.templateId, /^[a-zA-Z0-9-]{8,64}$/);
    assert.match(publication.buildId, /^[a-f0-9-]{36}$/);
    for (const k of ["rootfsSha256", "headerSha256", "metadataSha256"]) assert.match(publication[k], /^[a-f0-9]{64}$/);
    const status = await sdk.Template.getBuildStatus(publication, credentials.options);
    assert.equal(status.templateID, publication.templateId);
    assert.equal(status.buildID, publication.buildId);
    assert.equal(status.status, "ready");
    Object.assign(receipt, {
      publication,
      templateId: publication.templateId,
      buildId: publication.buildId,
      phase: "ready",
    });
    await saveReceipt(file, receipt);
    return receipt;
  });
}
async function main(args) {
  const publish = args[0] === "publish";
  if (publish) args = args.slice(1);
  assert.equal(
    args.length,
    3,
    "Usage: hands-cold-template.mjs [publish] PLAN_DIRECTORY PRIVATE_CONFIG OPERATOR_RECEIPT",
  );
  const [directory, config, seedFile] = args.map((value) => resolve(value));
  const credentials = await connection(config);
  const seed = JSON.parse(await readPrivate(seedFile));
  const require = createRequire(new URL("../../packages/sandbox-e2b/package.json", import.meta.url));
  const sdk = await import(pathToFileURL(require.resolve("e2b")).href);
  const operation = publish ? acceptColdPublication : buildColdTemplate;
  console.log(JSON.stringify(await operation(directory, credentials, seed, sdk), null, 2));
}
if (import.meta.main)
  main(process.argv.slice(2)).catch(() => {
    console.error("Cold template operation failed. Inspect the receipt; no operation was retried.");
    process.exitCode = 1;
  });
