import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, readFile, mkdir, rename, writeFile, rmdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const digest = /^[a-z0-9][a-z0-9.:-]*\/[a-zA-Z0-9._/-]+@sha256:[a-f0-9]{64}$/;
const hash = (value) => createHash("sha256").update(value).digest("hex");
const json = (value) => JSON.stringify(value, null, 2) + "\n";
const read = async (file) => JSON.parse(await readFile(file, "utf8"));
const save = async (file, value) => {
  const temporary = file + "." + process.pid + ".tmp";
  await writeFile(temporary, json(value), { mode: 0o600, flag: "wx" });
  await rename(temporary, file);
};

// CLI-only private input. Open without following a final symlink and validate the
// descriptor before reading; neither keys nor vendor error bodies enter receipts.
export async function readPrivate(file) {
  assert.ok(isAbsolute(file), "Private file path must be absolute");
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    assert.ok(
      info.isFile() && info.uid === process.getuid() && !(info.mode & 0o077),
      "Private file must be owned by this user with mode 0600",
    );
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}
function endpoint(value) {
  const url = new URL(value);
  assert.ok(
    url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash,
    "Expected a trusted HTTPS endpoint",
  );
  return url.href.replace(/\/$/, "");
}
export async function connection(file) {
  const config = JSON.parse(await readPrivate(file));
  assert.equal(config.schemaVersion, 1);
  assert.equal(config.backend, "e2b");
  const apiKey = (await readPrivate(config.apiKeyFile)).trim();
  assert.ok(apiKey && !/\s/.test(apiKey), "Invalid API key");
  const registry = config.registryCredentialsFile
    ? JSON.parse(await readPrivate(config.registryCredentialsFile))
    : undefined;
  if (registry)
    assert.ok(
      typeof registry.username === "string" &&
        registry.username &&
        typeof registry.password === "string" &&
        registry.password,
      "Invalid registry credentials",
    );
  return {
    options: {
      apiUrl: endpoint(config.apiUrl),
      sandboxUrl: endpoint(config.sandboxUrl),
      apiKey,
      requestTimeoutMs: 30000,
    },
    registry,
  };
}
export function makePlan(snapshot, name, cpuCount = 4, memoryMB = 8192) {
  const hands = snapshot.images?.hands;
  const sourceImage = typeof hands === "string" ? hands : hands?.ref;
  assert.match(sourceImage ?? "", digest, "Supply the immutable registry digest of the Hands image");
  const image = hands?.mirrorRef ?? sourceImage;
  assert.match(image, digest, "Mirror must use an immutable registry digest");
  assert.equal(image.split("@")[1], sourceImage.split("@")[1], "Mirror must preserve the original OCI manifest digest");
  if (hands?.platform) assert.deepEqual(hands.platform, { Os: "linux", Architecture: "amd64" });
  assert.match(name, /^[a-z][a-z0-9-]{2,62}$/, "Use a new versioned template name");
  assert.ok(Number.isSafeInteger(cpuCount) && cpuCount > 0 && cpuCount <= 64);
  assert.ok(Number.isSafeInteger(memoryMB) && memoryMB >= 512 && memoryMB <= 262144);
  return {
    schemaVersion: 1,
    image,
    ...(image !== sourceImage ? { sourceImage } : {}),
    name,
    cpuCount,
    memoryMB,
    workspaceRoot: "/workspace",
    user: "user",
    python: "/usr/bin/python3",
    releaseSourceRevision: snapshot.sourceRevision ?? null,
    releaseId: snapshot.releaseId ?? null,
  };
}
export async function planTemplate(snapshotFile, directory, name, cpu, memory) {
  const plan = makePlan(await read(snapshotFile), name, cpu, memory);
  await mkdir(directory, { mode: 0o700 }); // Never overwrite a build or deployment.
  await writeFile(join(directory, "plan.json"), json(plan), { mode: 0o600, flag: "wx" });
  return plan;
}
export async function loadPlan(directory) {
  const bytes = await readFile(join(directory, "plan.json"), "utf8");
  const plan = JSON.parse(bytes);
  const checked = makePlan(
    {
      images: { hands: plan.sourceImage ? { ref: plan.sourceImage, mirrorRef: plan.image } : plan.image },
      sourceRevision: plan.releaseSourceRevision,
      releaseId: plan.releaseId,
    },
    plan.name,
    plan.cpuCount,
    plan.memoryMB,
  );
  assert.deepEqual(plan, checked, "Invalid template plan");
  return { plan, planSha256: hash(bytes) };
}
const marker = "/opt/opencraft/e2b-hands-template.json";
export function templateDefinition(Template, plan, registry) {
  // All tools and owner bundles come from the exact released Hands image.
  // The E2B process API is the transport here: Compose's Unix-socket owners need
  // Brain mounts and must not be booted into a shared template snapshot.
  const metadata = Buffer.from(json({ schemaVersion: 1, image: plan.image })).toString("base64");
  return Template()
    .fromImage(plan.image, registry)
    .setUser("root")
    .setWorkdir("/opt/opencraft")
    .runCmd(
      `/usr/bin/python3 -c 'import base64,pathlib; pathlib.Path("${marker}").write_bytes(base64.b64decode("${metadata}"))'`,
    )
    .runCmd("id -u user >/dev/null 2>&1 || useradd --create-home --shell /bin/bash user")
    .runCmd("install -d -o user -g user -m 0700 /workspace")
    .setEnvs({
      PATH: "/opt/opencraft/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      OPENCRAFT_TERMINAL_WORKSPACE_ROOTS: JSON.stringify([plan.workspaceRoot]),
    })
    .setUser(plan.user)
    .setWorkdir(plan.workspaceRoot)
    .runCmd(probeCommand(plan));
}
export function probeCommand(plan) {
  const program =
    `const fs=require('node:fs'),assert=require('node:assert/strict');\n` +
    `assert.equal(JSON.parse(fs.readFileSync('${marker}')).image,${JSON.stringify(plan.image)});\n` +
    `for(const p of ['bin/node','runtime/codex/bin/codex','runtime/browser/electron/electron'])fs.accessSync('/opt/opencraft/'+p,fs.constants.X_OK);\n` +
    `for(const p of ['native-hands.mjs','hands-files-owner.mjs','hands-terminal-owner.mjs'])assert.ok(fs.statSync('/opt/opencraft/runtime/'+p).size>0);\n` +
    `const version=JSON.parse(fs.readFileSync('/opt/opencraft/web/version.json'));\n` +
    `const nfs='/usr/local/share/e2b-volume/nfs-modules.json';\n` +
    `const nfsModules=fs.existsSync(nfs)?JSON.parse(fs.readFileSync(nfs)):null;\n` +
    `fs.accessSync('/workspace',fs.constants.W_OK);\n` +
    `console.log(JSON.stringify({image:${JSON.stringify(plan.image)},handsSourceRevision:version.sourceRevision,node:process.version,workspaceRoot:'/workspace',workspaceFsType:fs.statfsSync('/workspace').type,guestKernel:require('node:os').release(),nfsModulesArchiveSha256:nfsModules?.archiveSha256}));`;
  return `/usr/bin/python3 -c 'import ssl,pty,fcntl,json; assert ssl.create_default_context().get_ca_certs()' && git --version >/dev/null && /opt/opencraft/bin/node -e '${program.replaceAll("'", "'\\''")}'`;
}
async function submitBuild(directory, credentials, sdk) {
  const { plan, planSha256 } = await loadPlan(directory);
  assert.equal(
    await sdk.Template.exists(plan.name, credentials.options),
    false,
    "Template name already exists; choose a new versioned name",
  );
  const receiptFile = join(directory, "receipt.json");
  const receipt = {
    schemaVersion: 1,
    planSha256,
    image: plan.image,
    ...(plan.sourceImage ? { sourceImage: plan.sourceImage } : {}),
    name: plan.name,
    phase: "submitting",
    createdAt: new Date().toISOString(),
  };
  // A second build may have taken effect even when its acknowledgement was lost.
  await writeFile(receiptFile, json(receipt), { mode: 0o600, flag: "wx" });
  try {
    const template = templateDefinition(sdk.Template, plan, credentials.registry);
    const build = await sdk.Template.buildInBackground(template, plan.name, {
      ...credentials.options,
      cpuCount: plan.cpuCount,
      memoryMB: plan.memoryMB,
    });
    assert.ok(build.templateId && build.buildId, "Builder did not return build identifiers");
    Object.assign(receipt, { phase: "building", templateId: build.templateId, buildId: build.buildId });
    await save(receiptFile, receipt);
    return receipt;
  } catch (error) {
    if (Number.isInteger(error?.statusCode)) receipt.httpStatus = error.statusCode;
    // No automatic resubmission: inspect the cluster using the unique name.
    receipt.phase = "submission-unknown";
    await save(receiptFile, receipt);
    throw new Error("Template submission was not acknowledged; reconcile the unique name before any new build");
  }
}
async function tracked(directory) {
  const loaded = await loadPlan(directory),
    receipt = await read(join(directory, "receipt.json"));
  assert.equal(receipt.planSha256, loaded.planSha256, "Plan changed after submission");
  return { ...loaded, receipt };
}
async function observeBuild(directory, credentials, sdk) {
  const { receipt } = await tracked(directory);
  assert.ok(receipt.templateId && receipt.buildId, "No acknowledged build; reconcile the submission on the cluster");
  const status = await sdk.Template.getBuildStatus(receipt, credentials.options);
  assert.ok(["building", "waiting", "ready", "error"].includes(status.status), "Invalid builder status");
  assert.equal(status.templateID, receipt.templateId);
  assert.equal(status.buildID, receipt.buildId);
  receipt.phase = status.status;
  await save(join(directory, "receipt.json"), receipt);
  return receipt;
}
async function verifyBuild(directory, credentials, sdk) {
  const { plan, receipt } = await tracked(directory);
  assert.equal(receipt.phase, "ready", "Template must be ready");
  if (receipt.method === "filesystem-snapshot")
    assert.equal(receipt.buildSandbox.cleanup, "confirmed", "Build VM deletion must be confirmed");
  assert.equal(receipt.verification, undefined, "Verification already submitted; reconcile it before allocating again");
  receipt.verification = { phase: "creating" };
  const persist = () => save(join(directory, "receipt.json"), receipt);
  await persist();
  let sandbox;
  try {
    sandbox = await sdk.Sandbox.create(receipt.templateId, {
      ...credentials.options,
      timeoutMs: 120000,
      metadata: {
        "opencraft-purpose": "hands-template-verification",
        ...(receipt.buildId
          ? { "opencraft-template-build": receipt.buildId }
          : { "opencraft-template-snapshot": receipt.snapshotId }),
      },
    });
    receipt.verification = { phase: "running", sandboxId: sandbox.sandboxId };
    await persist();
    const info = await sandbox.getInfo({ requestTimeoutMs: 30000 });
    assert.equal(info.cpuCount, plan.cpuCount);
    assert.equal(info.memoryMB, plan.memoryMB);
    const result = await sandbox.commands.run(probeCommand(plan), {
      timeoutMs: 30000,
      user: plan.user,
      cwd: plan.workspaceRoot,
    });
    assert.equal(result.exitCode, 0);
    const observation = JSON.parse(result.stdout.trim());
    assert.equal(observation.image, plan.image);
    if (receipt.seed?.kernelAdaptation) {
      assert.equal(observation.guestKernel, receipt.seed.kernelAdaptation.kernel);
      assert.equal(observation.nfsModulesArchiveSha256, receipt.seed.kernelAdaptation.archiveSha256);
    }
    receipt.verification.observation = observation;
    receipt.verification.phase = "passed";
  } catch {
    receipt.verification.phase = sandbox ? "failed" : "creation-unknown";
    throw new Error("Hands template verification failed; inspect the private receipt and provider state");
  } finally {
    if (sandbox) {
      receipt.verification.cleanup = "unknown";
      await persist();
      try {
        await sandbox.kill({ requestTimeoutMs: 30000 }).catch(() => {});
        try {
          await sandbox.getInfo({ requestTimeoutMs: 30000 });
        } catch (error) {
          if (!(error instanceof sdk.SandboxNotFoundError)) throw error;
          receipt.verification.cleanup = "confirmed";
        }
        assert.equal(receipt.verification.cleanup, "confirmed", "Sandbox deletion not confirmed");
      } finally {
        await persist();
      }
    } else await persist();
  }
  return receipt;
}
// Keep status writes from erasing a concurrently acquired VM identity. A crash
// leaves the lock and intent in place for explicit operator reconciliation.
async function exclusive(directory, operation) {
  const lock = join(directory, ".operation-lock");
  await mkdir(lock, { mode: 0o700 });
  try {
    return await operation();
  } finally {
    await rmdir(lock);
  }
}
export const buildTemplate = (directory, credentials, sdk) =>
  exclusive(directory, () => submitBuild(directory, credentials, sdk));
export const buildStatus = (directory, credentials, sdk) =>
  exclusive(directory, () => observeBuild(directory, credentials, sdk));
export const verifyTemplate = (directory, credentials, sdk) =>
  exclusive(directory, () => verifyBuild(directory, credentials, sdk));
export { save as saveReceipt, exclusive as exclusiveOperation };

async function main(args) {
  const [action, ...rest] = args;
  if (action === "plan") {
    assert.ok(
      rest.length >= 3 && rest.length <= 5,
      "plan RELEASE_JSON NEW_DIRECTORY UNIQUE_NAME [CPU_COUNT MEMORY_MB]",
    );
    const [snapshot, directory, name, cpu = "4", memory = "8192"] = rest;
    console.log(json(await planTemplate(snapshot, resolve(directory), name, Number(cpu), Number(memory))));
    return;
  }
  assert.ok(
    ["build", "status", "verify"].includes(action) && rest.length === 2,
    "Usage: hands-template.mjs plan|build|status|verify (see docs/hands-e2b-templates.md)",
  );
  const [directory, config] = rest;
  const credentials = await connection(resolve(config));
  const require = createRequire(new URL("../../packages/sandbox-e2b/package.json", import.meta.url));
  const sdk = await import(pathToFileURL(require.resolve("e2b")).href);
  const operation = { build: buildTemplate, status: buildStatus, verify: verifyTemplate }[action];
  console.log(json(await operation(resolve(directory), credentials, sdk)));
}
if (import.meta.main) {
  main(process.argv.slice(2)).catch(() => {
    console.error(
      "Hands template operation failed; inspect the build receipt and cluster state. No operation was retried.",
    );
    process.exitCode = 1;
  });
}
