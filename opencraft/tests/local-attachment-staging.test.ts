import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";

import { LocalAttachmentStagingService } from "../apps/local-agent-host/src/attachments/local-attachment-staging.js";

test("Local attachment staging creates its owned directory before the first write", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencraft-attachment-stage-"));
  const root = join(directory, "attachments");
  const service = new LocalAttachmentStagingService(root);
  try {
    const result = await service.stage({
      clientAttachmentId: "attachment-1",
      name: "KFPA 模板(1).docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      size: 4,
      source: { kind: "client-bytes", dataBase64: "AQIDBA==" },
    });
    assert.equal(result.ref.location.kind, "host-file");
    if (result.ref.location.kind !== "host-file") throw new Error("Expected host-file ref");
    assert.equal(relative(root, result.ref.location.path).startsWith(".."), false);
    assert.deepEqual(await readFile(result.ref.location.path), Buffer.from([1, 2, 3, 4]));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Local attachment staging is idempotent by client identity and rejects conflicts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencraft-attachment-idempotency-"));
  const service = new LocalAttachmentStagingService(join(directory, "attachments"));
  const request = {
    clientAttachmentId: "attachment-idempotent",
    name: "notes.txt",
    mimeType: "text/plain",
    size: 5,
    source: { kind: "client-bytes" as const, dataBase64: "aGVsbG8=" },
  };
  try {
    const first = await service.stage(request);
    const replay = await service.stage(request);
    assert.deepEqual(replay, first);
    await assert.rejects(
      () => service.stage({ ...request, name: "other.txt" }),
      /different metadata/i,
    );
    await assert.rejects(
      () => service.stage({
        ...request,
        source: { kind: "client-bytes", dataBase64: "d29ybGQ=" },
      }),
      /different content/i,
    );
    assert.deepEqual(await service.remove({ id: request.clientAttachmentId }), {
      removed: true,
    });
    assert.deepEqual(await service.remove({ id: request.clientAttachmentId }), {
      removed: false,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Local attachment staging rejects malformed identity, bytes, and size before writing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencraft-attachment-invalid-"));
  const service = new LocalAttachmentStagingService(join(directory, "attachments"));
  const base = {
    clientAttachmentId: "attachment-invalid",
    name: "notes.txt",
    mimeType: "text/plain",
    size: 5,
    source: { kind: "client-bytes" as const, dataBase64: "aGVsbG8=" },
  };
  try {
    await assert.rejects(
      () => service.stage({ ...base, clientAttachmentId: "../escape" }),
      /identity/i,
    );
    await assert.rejects(
      () => service.stage({ ...base, source: { kind: "client-bytes", dataBase64: "%%%=" } }),
      /base64/i,
    );
    await assert.rejects(
      () => service.stage({ ...base, size: 4 }),
      /does not match/i,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Local attachment staging keeps reserved manifest names separate from file content", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencraft-attachment-name-"));
  const service = new LocalAttachmentStagingService(join(directory, "attachments"));
  try {
    const staged = await service.stage({
      clientAttachmentId: "attachment-manifest-name",
      name: "manifest.json",
      mimeType: "application/json",
      size: 4,
      source: { kind: "client-bytes", dataBase64: "AQIDBA==" },
    });
    assert.equal(staged.ref.location.kind, "host-file");
    if (staged.ref.location.kind !== "host-file") throw new Error("Expected host-file ref");
    assert.deepEqual(await readFile(staged.ref.location.path), Buffer.from([1, 2, 3, 4]));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Host path lookup accepts only a live staged file with its original name", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencraft-attachment-lookup-"));
  const service = new LocalAttachmentStagingService(join(directory, "attachments"));
  try {
    const staged = await service.stage({
      clientAttachmentId: "lookup-1", name: "受众广.md", mimeType: "text/markdown", size: 5,
      source: { kind: "client-bytes", dataBase64: "aGVsbG8=" },
    });
    if (staged.ref.location.kind !== "host-file") throw new Error("Expected host-file ref");
    const path = staged.ref.location.path;
    assert.deepEqual(await service.referenceForHostPath("受众广.md", path), staged.ref);
    assert.equal(await service.referenceForHostPath("other.md", join(directory, "other.md")), null);
    await assert.rejects(() => service.referenceForHostPath("other.md", path), /name|match/i);
    await service.remove({ id: "lookup-1" });
    await assert.rejects(() => service.referenceForHostPath("受众广.md", path));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
