import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
  ArtifactCatalog,
  prepareLocalArtifact,
  inspectArtifactFile,
} from "../../apps/local-agent-host/src/artifacts/catalog.js";

async function setup(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "artifacts-"));
  const catalog = new ArtifactCatalog(root);
  t.after(async () => {
    catalog.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, catalog };
}
const metadata = { name: "image.png", mimeType: "image/png", origin: "generation" as const };
const options = { maxBytes: 100, reference: { owner: "message-a", slot: "output-0" } };

test("uploaded and generated artifacts have immutable identity, durable references and GC protection", async (t) => {
  const { catalog } = await setup(t);
  const a = await catalog.ingest(
    { scope: "actor-a", key: "task/slot/attempt" },
    metadata,
    Readable.from(["abc"]),
    options,
  );
  const repeated = await catalog.ingest(
    { scope: "actor-a", key: "task/slot/attempt" },
    metadata,
    Readable.from(["abc"]),
    options,
  );
  assert.equal(a.id, repeated.id);
  assert.equal(a.path, repeated.path);
  await assert.rejects(
    catalog.ingest({ scope: "actor-a", key: "task/slot/attempt" }, metadata, Readable.from(["different"]), options),
    /different/,
  );
  assert.equal(catalog.gcCandidates(Date.now() + 1).length, 0);
  catalog.cloneReferences("message-a", "fork");
  catalog.release("message-a");
  assert.equal(catalog.gcCandidates(Date.now() + 1).length, 0);
  catalog.lease(a.id, "reader");
  catalog.release("fork");
  assert.equal(catalog.gcCandidates(Date.now() + 1).length, 0);
  catalog.releaseLease("reader");
  assert.equal(catalog.gcCandidates(Date.now() + 1).length, 1);
  assert.equal((await readFile(a.path)).toString(), "abc");
});

test("failed, cancelled and conflicting ingestion never leaves content or a reference behind", async (t) => {
  const { catalog, root } = await setup(t);
  await assert.rejects(
    catalog.ingest({ scope: "a", key: "short" }, metadata, Readable.from(["abc"]), { ...options, size: 4 }),
    /mismatch/,
  );
  await assert.rejects(
    catalog.ingest({ scope: "a", key: "long" }, metadata, Readable.from(["abc"]), { ...options, maxBytes: 2 }),
    /size/,
  );
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(
    catalog.ingest({ scope: "a", key: "cancel" }, metadata, Readable.from(["abc"]), {
      ...options,
      signal: abort.signal,
    }),
  );
  assert.deepEqual(await readdir(join(root, "content")), []);
});

test("local writable storage uses an isolated registered copy, validates reuse and rejects corruption", async (t) => {
  const { catalog } = await setup(t);
  const a = await catalog.ingest({ scope: "a", key: "file" }, metadata, Readable.from(["abc"]), options);
  const copy = await prepareLocalArtifact(a, catalog, "execution");
  assert.notEqual(copy.path, a.path);
  assert.equal((await prepareLocalArtifact(a, catalog, "execution-2")).path, copy.path);
  await writeFile(copy.path, "bad");
  assert.equal((await readFile(a.path)).toString(), "abc");
  await assert.rejects(prepareLocalArtifact(a, catalog, "execution-3"), /changed/);
  assert.equal((await inspectArtifactFile(a.path)).sha256, a.sha256);
});

test("catalog reopening preserves content and reference protection", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "artifact-reopen-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let catalog = new ArtifactCatalog(root);
  const a = await catalog.ingest({ scope: "a", key: "file" }, metadata, Readable.from(["abc"]), options);
  catalog.close();
  catalog = new ArtifactCatalog(root);
  try {
    assert.deepEqual(catalog.get(a.id), a);
    assert.equal(catalog.gcCandidates(Date.now() + 1).length, 0);
  } finally {
    catalog.close();
  }
});

test("AIGC output ingestion shares the catalog, preserves slots and can become an input attachment", async (t) => {
  const { catalog, root } = await setup(t);
  const { captureGeneratedImage } = await import("../../apps/local-agent-host/src/artifacts/generated-output.js");
  const { LocalAttachmentStagingService } =
    await import("../../apps/local-agent-host/src/attachments/local-attachment-staging.js");
  const item = {
    id: "output-1",
    type: "imageGeneration",
    status: "completed",
    result: Buffer.from("png fixture bytes").toString("base64"),
  };
  const generated = await captureGeneratedImage(catalog, "native", "thread-a", item);
  assert.ok(generated);
  assert.equal((await captureGeneratedImage(catalog, "native", "thread-a", item))!.id, generated.id);
  await assert.rejects(
    captureGeneratedImage(catalog, "native", "thread-a", {
      ...item,
      result: Buffer.from("different").toString("base64"),
    }),
    /different/,
  );
  assert.equal(
    await captureGeneratedImage(catalog, "native", "thread-a", {
      ...item,
      id: "url",
      result: "https://example.invalid/expired",
    }),
    null,
  );
  const staging = new LocalAttachmentStagingService(join(root, "staging"), root);
  try {
    const input = await staging.prepareInput(
      [{ type: "mention", name: generated.name, path: generated.path }],
      "thread-b",
    );
    const path = JSON.parse(input[0]!.text.split("data: ")[1]).path;
    assert.equal(await readFile(path, "utf8"), "png fixture bytes");
    assert.notEqual(path, generated.path);
  } finally {
    await staging.close();
  }
});

test("prepared attachment text is consumable by DSH and Pi without controller-side stat of an execution path", async (t) => {
  const { root } = await setup(t);
  const { LocalAttachmentStagingService } =
    await import("../../apps/local-agent-host/src/attachments/local-attachment-staging.js");
  const { promptContent } = await import("../../apps/local-agent-host/src/dsh-appserver-adapter.js");
  const { compilePiInput } = await import("../../plugins/pi-engine/src/input.js");
  const staging = new LocalAttachmentStagingService(join(root, "uploads"), root);
  try {
    const { ref } = await staging.stage({
      clientAttachmentId: "file",
      name: "input.txt",
      mimeType: "text/plain",
      size: 3,
      source: { kind: "client-bytes", dataBase64: "YWJj" },
    });
    assert.equal(ref.location.kind, "host-file");
    const path = (ref.location as { path: string }).path;
    const prepared = await staging.prepareInput(
      [{ type: "mention", name: ref.name, path }],
      "thread",
      async (artifact) => ({ ...artifact, path: "/isolated-execution/input.txt" }),
    );
    const dsh = await promptContent(prepared),
      pi = await compilePiInput(prepared, null, root, { input: ["text"] });
    assert.ok(dsh[0]!.text.includes("/isolated-execution/input.txt"));
    assert.deepEqual(pi, dsh);
    assert.deepEqual(await staging.remove({ id: ref.id }), { removed: false });
  } finally {
    await staging.close();
  }
});

test("independent catalog connections serialize references to the same immutable version", async (t) => {
  const { root, catalog } = await setup(t);
  const other = new ArtifactCatalog(root);
  try {
    const [a, b] = await Promise.all([
      catalog.ingest({ scope: "same", key: "output" }, metadata, Readable.from(["abc"]), options),
      other.ingest({ scope: "same", key: "output" }, metadata, Readable.from(["abc"]), {
        ...options,
        reference: { owner: "other", slot: "output-0" },
      }),
    ]);
    assert.equal(a.id, b.id);
    assert.equal(a.path, b.path);
    catalog.release("message-a");
    assert.equal(other.gcCandidates(Date.now() + 1).length, 0);
    assert.equal((await readdir(join(root, "content"))).length, 1);
  } finally {
    other.close();
  }
});

test("separate Host processes can open the shared catalog and register one output", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "artifact-processes-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { spawn } = await import("node:child_process");
  const moduleUrl = new URL("../../apps/local-agent-host/src/artifacts/catalog.ts", import.meta.url).href;
  const script = `import {ArtifactCatalog} from ${JSON.stringify(moduleUrl)}; import {Readable} from 'node:stream';
    const catalog=new ArtifactCatalog(process.argv[1]);
    try{const artifact=await catalog.ingest({scope:'host',key:'output'},{name:'output.bin',mimeType:'application/octet-stream',origin:'generation'},Readable.from(['abc']),{maxBytes:10,reference:{owner:process.argv[2],slot:'output'}});console.log(JSON.stringify(artifact));}finally{catalog.close();}`;
  const run = (owner: string) =>
    new Promise<any>((accept, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, root, owner], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "",
        error = "";
      child.stdout.on("data", (chunk) => (out += chunk));
      child.stderr.on("data", (chunk) => (error += chunk));
      child.on("error", reject);
      child.on("exit", (code) => (code === 0 ? accept(JSON.parse(out)) : reject(Error(error))));
    });
  const [a, b] = await Promise.all([run("one"), run("two")]);
  assert.equal(a.id, b.id);
  assert.equal(a.path, b.path);
  const catalog = new ArtifactCatalog(root);
  try {
    catalog.release("one");
    assert.equal(catalog.gcCandidates(Date.now() + 1).length, 0);
  } finally {
    catalog.close();
  }
});

test("lost acknowledgement after catalog commit preserves the published bytes for reconciliation", async (t) => {
  const { catalog } = await setup(t);
  const register = catalog.register.bind(catalog);
  catalog.register = (...args) => {
    register(...args);
    throw Error("Lost commit confirmation");
  };
  const identity = { scope: "a", key: "unknown-commit" };
  await assert.rejects(catalog.ingest(identity, metadata, Readable.from(["abc"]), options), /confirmation/);
  const committed = catalog.get(catalog.id(identity));
  assert.ok(committed);
  assert.equal(await readFile(committed.path, "utf8"), "abc");
  assert.equal(catalog.incompleteIngestions()[0]!.has_committed_artifact, 1);
  catalog.register = register;
  assert.equal((await catalog.ingest(identity, metadata, Readable.from(["abc"]), options)).path, committed.path);
});

test("an upload registered by one engine can be attached through another without a second original", async (t) => {
  const { root, catalog } = await setup(t);
  const { LocalAttachmentStagingService } =
    await import("../../apps/local-agent-host/src/attachments/local-attachment-staging.js");
  const codex = new LocalAttachmentStagingService(join(root, "codex", "attachments"), root);
  const agent = new LocalAttachmentStagingService(join(root, "agent", "attachments"), root);
  try {
    const { ref } = await codex.stage({
      clientAttachmentId: "cross-engine",
      name: "notes.txt",
      mimeType: "text/plain",
      size: 3,
      source: { kind: "client-bytes", dataBase64: "YWJj" },
    });
    const path = (ref.location as { path: string }).path;
    const original = catalog.findPath(path);
    assert.ok(original);
    const input = await agent.prepareInput([{ type: "mention", name: ref.name, path }], "pi_thread");
    assert.equal(await readFile(JSON.parse(input[0]!.text.split("data: ")[1]).path, "utf8"), "abc");
    assert.equal(catalog.findPath(path)!.id, original.id);
    assert.deepEqual(await codex.remove({ id: ref.id }), { removed: false });
  } finally {
    await codex.close();
    await agent.close();
  }
});
