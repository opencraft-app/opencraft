import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, readFile, chmod, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { Template } from "e2b";
import { join } from "node:path";
import {
  buildStatus,
  buildTemplate,
  connection,
  loadPlan,
  makePlan,
  planTemplate,
  readPrivate,
  templateDefinition,
  verifyTemplate,
} from "../../scripts/e2b/hands-template.mjs";
const image = "registry.example.com/team/hands@sha256:" + "a".repeat(64);
const snapshot = {
  images: { hands: { ref: image, platform: { Os: "linux", Architecture: "amd64" } } },
  sourceRevision: "b".repeat(40),
};
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "hands-e2b-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const release = join(root, "release.json"),
    directory = join(root, "build");
  await writeFile(release, JSON.stringify(snapshot));
  await planTemplate(release, directory, "hands-test-v1");
  return { root, directory, receipt: async () => JSON.parse(await readFile(join(directory, "receipt.json"), "utf8")) };
}
function sdkFixture() {
  const steps = [],
    requests = [];
  const builder = new Proxy(
    {},
    {
      get:
        (_, name) =>
        (...args) => {
          steps.push([name, ...args]);
          return builder;
        },
    },
  );
  const Template = Object.assign(() => builder, {
    exists: async () => false,
    buildInBackground: async (...args) => {
      requests.push(args);
      return { templateId: "template-test", buildId: "build-test" };
    },
    getBuildStatus: async () => ({ templateID: "template-test", buildID: "build-test", status: "ready" }),
  });
  class SandboxNotFoundError extends Error {}
  let killed = false;
  const sandbox = {
    sandboxId: "sandbox-test",
    getInfo: async () => {
      if (killed) throw new SandboxNotFoundError();
      return { cpuCount: 4, memoryMB: 8192 };
    },
    kill: async () => {
      killed = true;
    },
    commands: {
      run: async () => ({ exitCode: 0, stdout: JSON.stringify({ image, handsSourceRevision: "c".repeat(40) }) }),
    },
  };
  return { Template, SandboxNotFoundError, Sandbox: { create: async () => sandbox }, sandbox, steps, requests };
}
const credentials = {
  options: {
    apiUrl: "https://cluster.example.com",
    sandboxUrl: "https://proxy.example.com",
    apiKey: "private-api-key",
  },
  registry: { username: "private-user", password: "private-registry-password" },
};

test("plan consumes the Hands digest without substituting the release source revision for the Hands revision", () => {
  assert.equal(makePlan(snapshot, "hands-test-v1").image, image);
  for (const ref of ["hands:latest", "sha256:" + "a".repeat(64), "https://user:secret@registry/image"])
    assert.throws(() => makePlan({ images: { hands: ref } }, "hands-test-v1"));
  assert.throws(() => makePlan(snapshot, "hands-test-v1", 4.5));
  assert.throws(() =>
    makePlan({ images: { hands: { ref: image, platform: { Os: "linux", Architecture: "arm64" } } } }, "hands-test-v1"),
  );
});
test("template derives tools from the image and keeps registry credentials outside shell steps", () => {
  const sdk = sdkFixture();
  templateDefinition(sdk.Template, makePlan(snapshot, "hands-test-v1"), credentials.registry);
  assert.deepEqual(sdk.steps[0], ["fromImage", image, credentials.registry]);
  const commands = sdk.steps
    .filter((step) => step[0] === "runCmd")
    .flat()
    .join("\n");
  assert.ok(
    !commands.includes("apt-get") &&
      !commands.includes("npm install") &&
      !commands.includes("private-registry-password"),
  );
  assert.ok(!commands.includes("container-service.mjs"));
  assert.ok(sdk.steps.some((step) => step[0] === "setUser" && step[1] === "user"));
});
test("private config accepts configured endpoints and rejects world-readable and symlink secrets", async (t) => {
  const { root } = await fixture(t),
    key = join(root, "key"),
    config = join(root, "config.json");
  await writeFile(key, "secret", { mode: 0o600 });
  await writeFile(
    config,
    JSON.stringify({
      schemaVersion: 1,
      backend: "e2b",
      apiUrl: "https://cluster.example.com",
      sandboxUrl: "https://proxy.example.com",
      apiKeyFile: key,
    }),
    { mode: 0o600 },
  );
  assert.equal((await connection(config)).options.apiUrl, "https://cluster.example.com");
  const link = join(root, "key-link");
  await symlink(key, link);
  await assert.rejects(readPrivate(link));
  await chmod(key, 0o644);
  await assert.rejects(connection(config));
});
test("build records IDs before status and never persists API or registry secrets", async (t) => {
  const { directory, receipt } = await fixture(t),
    sdk = sdkFixture();
  await buildTemplate(directory, credentials, sdk);
  assert.equal((await receipt()).phase, "building");
  assert.deepEqual(sdk.requests[0][2], { ...credentials.options, cpuCount: 4, memoryMB: 8192 });
  assert.equal((await buildStatus(directory, credentials, sdk)).phase, "ready");
  assert.ok(!JSON.stringify(await receipt()).includes("private-"));
  await assert.rejects(buildTemplate(directory, credentials, sdk));
  assert.equal(sdk.requests.length, 1);
});
test("existing names are rejected without creating a build", async (t) => {
  const { directory } = await fixture(t),
    sdk = sdkFixture();
  sdk.Template.exists = async () => true;
  await assert.rejects(buildTemplate(directory, credentials, sdk), /already exists/);
  assert.equal(sdk.requests.length, 0);
});
test("lost submission acknowledgement stays unknown and cannot be resubmitted", async (t) => {
  const { directory, receipt } = await fixture(t),
    sdk = sdkFixture();
  let calls = 0;
  sdk.Template.buildInBackground = async () => {
    calls++;
    throw new Error("private-registry-password");
  };
  await assert.rejects(buildTemplate(directory, credentials, sdk), /not acknowledged/);
  assert.equal((await receipt()).phase, "submission-unknown");
  await assert.rejects(buildTemplate(directory, credentials, sdk));
  assert.equal(calls, 1);
  assert.ok(!JSON.stringify(await receipt()).includes("private-registry-password"));
});
test("edited plan cannot be used to poll or verify another build", async (t) => {
  const { directory } = await fixture(t),
    sdk = sdkFixture();
  await buildTemplate(directory, credentials, sdk);
  const { plan } = await loadPlan(directory);
  await writeFile(join(directory, "plan.json"), JSON.stringify({ ...plan, name: "changed-name" }));
  await assert.rejects(buildStatus(directory, credentials, sdk), /Plan changed/);
});
test("verification checks the image and effective resource budget, then confirms destruction", async (t) => {
  const { directory, receipt } = await fixture(t),
    sdk = sdkFixture();
  await buildTemplate(directory, credentials, sdk);
  await buildStatus(directory, credentials, sdk);
  await verifyTemplate(directory, credentials, sdk);
  assert.deepEqual((await receipt()).verification, {
    phase: "passed",
    sandboxId: "sandbox-test",
    observation: { image, handsSourceRevision: "c".repeat(40) },
    cleanup: "confirmed",
  });
  await assert.rejects(verifyTemplate(directory, credentials, sdk));
});
test("resource mismatch still destroys the VM and is not reported as passed", async (t) => {
  const { directory, receipt } = await fixture(t),
    sdk = sdkFixture();
  const original = sdk.sandbox.getInfo;
  sdk.sandbox.getInfo = async () => ({ ...(await original()), cpuCount: 8 });
  await buildTemplate(directory, credentials, sdk);
  await buildStatus(directory, credentials, sdk);
  await assert.rejects(verifyTemplate(directory, credentials, sdk));
  assert.equal((await receipt()).verification.phase, "failed");
  assert.equal((await receipt()).verification.cleanup, "confirmed");
});
test("successful delete response without confirmed absence remains unknown", async (t) => {
  const { directory, receipt } = await fixture(t),
    sdk = sdkFixture();
  sdk.sandbox.kill = async () => {};
  await buildTemplate(directory, credentials, sdk);
  await buildStatus(directory, credentials, sdk);
  await assert.rejects(verifyTemplate(directory, credentials, sdk), /not confirmed/);
  assert.equal((await receipt()).verification.cleanup, "unknown");
});

test("pinned E2B SDK sends the released image and private registry auth through the v3/v2 build protocol", async (t) => {
  const { directory } = await fixture(t),
    requests = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push({
      path: request.url,
      method: request.method,
      body: body ? JSON.parse(body) : null,
      key: request.headers["x-api-key"],
    });
    response.setHeader("content-type", "application/json");
    if (request.url.startsWith("/templates/aliases/")) {
      response.writeHead(404);
      response.end('{"message":"not found"}');
    } else if (request.url === "/v3/templates") {
      response.writeHead(202);
      response.end(JSON.stringify({ templateID: "template-sdk", buildID: "build-sdk", tags: [] }));
    } else if (request.url === "/v2/templates/template-sdk/builds/build-sdk") {
      response.writeHead(202);
      response.end("{}");
    } else if (request.url.startsWith("/templates/template-sdk/builds/build-sdk/status"))
      response.end(
        JSON.stringify({ templateID: "template-sdk", buildID: "build-sdk", status: "ready", logEntries: [], logs: [] }),
      );
    else {
      response.writeHead(404);
      response.end("{}");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const local = {
    ...credentials,
    options: { ...credentials.options, apiUrl: "http://127.0.0.1:" + server.address().port },
  };
  const receipt = await buildTemplate(directory, local, { Template });
  assert.equal(receipt.templateId, "template-sdk");
  assert.equal((await buildStatus(directory, local, { Template })).phase, "ready");
  const creation = requests.find((r) => r.path === "/v3/templates");
  assert.equal(creation.body.cpuCount, 4);
  assert.equal(creation.body.memoryMB, 8192);
  const build = requests.find((r) => r.method === "POST" && r.path.startsWith("/v2/templates/"));
  assert.equal(build.body.fromImage, image);
  assert.deepEqual(build.body.fromImageRegistry, { type: "registry", ...credentials.registry });
  assert.ok(build.body.steps.some((s) => s.type === "RUN"));
  assert.ok(requests.every((r) => r.key === credentials.options.apiKey));
});

test("an ambiguous VM create is recorded and cannot be replayed", async (t) => {
  const { directory, receipt } = await fixture(t),
    sdk = sdkFixture();
  let calls = 0;
  sdk.Sandbox.create = async () => {
    calls++;
    throw Error("lost acknowledgement");
  };
  await buildTemplate(directory, credentials, sdk);
  await buildStatus(directory, credentials, sdk);
  await assert.rejects(verifyTemplate(directory, credentials, sdk));
  assert.equal((await receipt()).verification.phase, "creation-unknown");
  await assert.rejects(verifyTemplate(directory, credentials, sdk));
  assert.equal(calls, 1);
});

test("concurrent verification admits only one VM and status cannot overwrite its receipt", async (t) => {
  const { directory, receipt } = await fixture(t),
    sdk = sdkFixture();
  await buildTemplate(directory, credentials, sdk);
  await buildStatus(directory, credentials, sdk);
  let entered, release;
  const creating = new Promise((resolve) => {
    entered = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let calls = 0;
  sdk.Sandbox.create = async () => {
    calls++;
    entered();
    await gate;
    return sdk.sandbox;
  };
  const first = verifyTemplate(directory, credentials, sdk);
  await creating;
  await assert.rejects(verifyTemplate(directory, credentials, sdk));
  await assert.rejects(buildStatus(directory, credentials, sdk));
  release();
  await first;
  assert.equal(calls, 1);
  assert.equal((await receipt()).verification.cleanup, "confirmed");
});

test("a cluster mirror changes only the registry location and preserves the OCI manifest identity", async (t) => {
  const mirror = "registry-mirror.example.com:15000/opencraft/hands@sha256:" + "a".repeat(64);
  const input = { images: { hands: { ref: image, mirrorRef: mirror } } };
  const plan = makePlan(input, "hands-mirrored-v1");
  assert.equal(plan.image, mirror);
  assert.equal(plan.sourceImage, image);
  assert.throws(
    () =>
      makePlan(
        { images: { hands: { ref: image, mirrorRef: mirror.replace(/a{64}$/, "b".repeat(64)) } } },
        "hands-mirrored-v1",
      ),
    /preserve/,
  );
  const { root } = await fixture(t),
    release = join(root, "mirror.json"),
    directory = join(root, "mirror-build");
  await writeFile(release, JSON.stringify(input));
  await planTemplate(release, directory, "hands-mirrored-v1");
  assert.deepEqual((await loadPlan(directory)).plan, plan);
  const sdk = sdkFixture();
  assert.equal((await buildTemplate(directory, credentials, sdk)).sourceImage, image);
  assert.equal(sdk.steps[0][1], mirror);
});

const { buildColdTemplate, validateSeed } = await import("../../scripts/e2b/hands-cold-template.mjs");
const seed = {
  schemaVersion: 1,
  phase: "ready",
  image,
  cpuCount: 4,
  memoryMB: 8192,
  filesystemOnly: true,
  seedTemplateId: "cold-seed-template",
  sourceArtifactId: "11111111-2222-4333-8444-555555555555",
  rootfsSha256: "a".repeat(64),
  headerSha256: "b".repeat(64),
  metadataSha256: "c".repeat(64),
};
test("cold builds prepare the image in one bounded VM, request a filesystem snapshot, and verify a fresh VM", async (t) => {
  const f = await fixture(t),
    sdk = sdkFixture();
  const commands = [],
    run = sdk.sandbox.commands.run;
  sdk.sandbox.commands.run = async (command, options) => {
    commands.push([command, options]);
    return run();
  };
  let options;
  sdk.sandbox.createSnapshot = async (opts) => {
    assert.deepEqual(commands.at(-1), ["sync", { user: "root", cwd: "/", timeoutMs: 30000 }]);
    options = opts;
    return { snapshotId: "cold-snapshot-id", names: [opts.name] };
  };
  const built = await buildColdTemplate(f.directory, credentials, seed, sdk);
  assert.equal(options.mode, "filesystem");
  assert.equal(built.templateId, "cold-snapshot-id");
  assert.equal(built.buildId, undefined, "A snapshot ID must not be relabelled as a build ID");
  assert.equal(built.buildSandbox.cleanup, "confirmed");
  assert.equal(built.buildSandbox.filesystemFlushed, true);
  assert.equal((await verifyTemplate(f.directory, credentials, sdkFixture())).verification.phase, "passed");
});
test("failed guest disk flush prevents publication and still confirms VM deletion", async (t) => {
  const f = await fixture(t),
    sdk = sdkFixture(),
    run = sdk.sandbox.commands.run;
  sdk.sandbox.commands.run = async (command) => (command === "sync" ? { exitCode: 1 } : run());
  sdk.sandbox.createSnapshot = async () => {
    assert.fail("Must not snapshot an unflushed filesystem");
  };
  await assert.rejects(buildColdTemplate(f.directory, credentials, seed, sdk));
  const receipt = await f.receipt();
  assert.equal(receipt.phase, "failed");
  assert.equal(receipt.buildSandbox.filesystemFlushed, undefined);
  assert.equal(receipt.buildSandbox.cleanup, "confirmed");
});
test("a cold guest with missing kernel provenance fails acceptance and is deleted", async (t) => {
  const f = await fixture(t),
    sdk = sdkFixture();
  sdk.sandbox.createSnapshot = async () => ({ snapshotId: "cold-snapshot-id" });
  await buildColdTemplate(
    f.directory,
    credentials,
    { ...seed, kernelAdaptation: { kernel: "6.12.0-test-kernel", archiveSha256: "d".repeat(64), installed: true } },
    sdk,
  );
  await assert.rejects(verifyTemplate(f.directory, credentials, sdkFixture()));
  const receipt = await f.receipt();
  assert.equal(receipt.verification.phase, "failed");
  assert.equal(receipt.verification.cleanup, "confirmed");
});
test("a lost filesystem snapshot acknowledgement is retained and cannot be replayed", async (t) => {
  const f = await fixture(t),
    sdk = sdkFixture();
  let snapshots = 0;
  sdk.sandbox.createSnapshot = async () => {
    snapshots++;
    throw new Error("lost acknowledgement");
  };
  await assert.rejects(buildColdTemplate(f.directory, credentials, seed, sdk));
  const receipt = await f.receipt();
  assert.equal(receipt.phase, "snapshot-unknown");
  assert.equal(receipt.buildSandbox.cleanup, "confirmed");
  await assert.rejects(buildColdTemplate(f.directory, credentials, seed, sdk));
  assert.equal(snapshots, 1);
});
test("cold seeds must match the planned image and effective resource budget", async (t) => {
  const f = await fixture(t),
    sdk = sdkFixture();
  assert.throws(() =>
    validateSeed({ ...seed, image: image.replaceAll("a", "b") }, makePlan(snapshot, "hands-test-v1")),
  );
  const original = sdk.sandbox.getInfo;
  let alive = true;
  sdk.sandbox.getInfo = async () => (alive ? { cpuCount: 8, memoryMB: 8192 } : original());
  const kill = sdk.sandbox.kill;
  sdk.sandbox.kill = async () => {
    alive = false;
    await kill();
  };
  await assert.rejects(buildColdTemplate(f.directory, credentials, seed, sdk));
  assert.equal((await f.receipt()).phase, "failed");
  assert.equal((await f.receipt()).buildSandbox.cleanup, "confirmed");
});

test("operator capture stays unpublished until a bound filesystem-only publication is ready", async (t) => {
  const f = await fixture(t),
    sdk = sdkFixture();
  let requested;
  sdk.sandbox.createSnapshot = async (opts) => {
    requested = opts;
    return { snapshotId: "staged-source-snapshot", names: [opts.name] };
  };
  const r = await buildColdTemplate(f.directory, credentials, { ...seed, captureMode: "memory" }, sdk);
  assert.equal(requested.mode, "full");
  assert.equal(r.phase, "awaiting-cold-publication");
  assert.equal(r.templateId, undefined);
  await assert.rejects(verifyTemplate(f.directory, credentials, sdkFixture()));
  const { acceptColdPublication } = await import("../../scripts/e2b/hands-cold-template.mjs");
  const publication = {
    schemaVersion: 1,
    phase: "ready",
    filesystemOnly: true,
    image,
    planSha256: r.planSha256,
    sourceSnapshotId: r.sourceSnapshotId,
    templateId: "published-cold-template",
    buildId: "11111111-2222-4333-8444-555555555555",
    rootfsSha256: "a".repeat(64),
    headerSha256: "b".repeat(64),
    metadataSha256: "c".repeat(64),
  };
  sdk.Template.getBuildStatus = async () => ({
    templateID: publication.templateId,
    buildID: publication.buildId,
    status: "ready",
  });
  await assert.rejects(
    acceptColdPublication(f.directory, credentials, { ...publication, sourceSnapshotId: "unrelated-snapshot" }, sdk),
  );
  assert.equal((await f.receipt()).phase, "awaiting-cold-publication");
  assert.equal((await acceptColdPublication(f.directory, credentials, publication, sdk)).phase, "ready");
});
test("pinned SDK uses memory true for full staging and memory false for filesystem snapshots", async (t) => {
  const { Sandbox } = await import("e2b");
  const bodies = [];
  const server = createServer(async (req, res) => {
    assert.equal(req.url, "/sandboxes/sandbox-test/snapshots");
    const chunks = [];
    for await (const c of req) chunks.push(c);
    bodies.push(JSON.parse(Buffer.concat(chunks)));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ snapshotID: "snapshot-test", names: ["test"] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const options = { apiUrl: `http://127.0.0.1:${server.address().port}`, apiKey: "local-fixture-key" };
  await Sandbox.createSnapshot("sandbox-test", { ...options, name: "test", mode: "full" });
  await Sandbox.createSnapshot("sandbox-test", { ...options, name: "test", mode: "filesystem" });
  assert.deepEqual(bodies, [
    { name: "test", memory: true },
    { name: "test", memory: false },
  ]);
});
test("adopting a known staging VM confirms cleanup even if connect loses its acknowledgement", async (t) => {
  const f = await fixture(t),
    sdk = sdkFixture();
  let allocations = 0,
    deletes = 0;
  sdk.Sandbox.create = async () => {
    allocations++;
    throw new Error("must not allocate");
  };
  sdk.Sandbox.connect = async () => {
    throw new Error("lost connect acknowledgement");
  };
  sdk.Sandbox.kill = async () => {
    deletes++;
  };
  sdk.Sandbox.getInfo = async () => {
    throw new sdk.SandboxNotFoundError();
  };
  await assert.rejects(
    buildColdTemplate(
      f.directory,
      credentials,
      { ...seed, buildSandboxId: "owned-staging-vm", buildSandboxPurpose: "hands-cold-template-build" },
      sdk,
    ),
  );
  assert.equal(allocations, 0);
  assert.equal(deletes, 1);
  assert.equal((await f.receipt()).buildSandbox.cleanup, "confirmed");
});

test("guest module adapter rejects unsafe artifacts before any privileged effect", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  await promisify(execFile)("/usr/bin/python3", ["-I", "tests/server/hands-e2b-nfs.test.py"]);
});
