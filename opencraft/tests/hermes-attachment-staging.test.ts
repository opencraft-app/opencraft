import assert from "node:assert/strict";
import test from "node:test";

import type { HermesHostFileSystem } from "../plugins/lightvela-hermes/src/hermes-appserver-bridge/dashboard-file-system";
import {
  HERMES_ATTACHMENT_STAGING_CAPABILITY,
  HermesAttachmentStagingService,
} from "../plugins/lightvela-hermes/src/hermes-appserver-bridge/attachment-staging";

class MemoryHermesFileSystem implements HermesHostFileSystem {
  readonly codexHome = "/home/agentuser/.hermes";
  readonly files = new Map<string, string>();

  async getMetadata(path: string) {
    if (!this.files.has(path)) throw new Error(`Hermes path does not exist: ${path}`);
    return { isDirectory: false, isFile: true, isSymlink: false, createdAtMs: 0, modifiedAtMs: 0 };
  }
  async readDirectory() { return { entries: [] }; }
  async readFile(path: string) {
    const dataBase64 = this.files.get(path);
    if (dataBase64 === undefined) throw new Error("HTTP 404: Path not found");
    return { dataBase64 };
  }
  async writeFile(path: string, dataBase64: string) { this.files.set(path, dataBase64); }
  async remove(path: string, recursive = false) {
    const matches = [...this.files.keys()].filter((candidate) => (
      candidate === path || (recursive && candidate.startsWith(`${path}/`))
    ));
    for (const match of matches) this.files.delete(match);
    return matches.length > 0;
  }
  dispose() {}
}

test("Hermes attachment staging owns a bounded Host directory and survives replay", async () => {
  const fileSystem = new MemoryHermesFileSystem();
  const service = new HermesAttachmentStagingService(fileSystem);
  const request = {
    clientAttachmentId: "attachment-shell-script",
    name: "a.sh",
    mimeType: "application/x-sh",
    size: 5,
    source: { kind: "client-bytes" as const, dataBase64: "aGVsbG8=" },
  };

  assert.deepEqual(service.capability, HERMES_ATTACHMENT_STAGING_CAPABILITY);
  const first = await service.stage(request);
  const replay = await new HermesAttachmentStagingService(fileSystem).stage(request);
  assert.deepEqual(replay, first);
  assert.equal(first.ref.location.kind, "host-file");
  if (first.ref.location.kind !== "host-file") throw new Error("Expected Host file");
  assert.match(first.ref.location.path, /^\/home\/agentuser\/\.hermes\/opencraft-attachments\/attachment-shell-script\/content-a\.sh$/u);
  assert.equal(fileSystem.files.get(first.ref.location.path), request.source.dataBase64);
  await assert.rejects(
    () => service.stage({ ...request, name: "other.sh" }),
    /different metadata/iu,
  );
  await assert.rejects(
    () => service.stage({ ...request, source: { kind: "client-bytes", dataBase64: "d29ybGQ=" } }),
    /different content/iu,
  );
  assert.deepEqual(await service.remove({ id: request.clientAttachmentId }), { removed: true });
  assert.deepEqual(await service.remove({ id: request.clientAttachmentId }), { removed: false });
});

test("Hermes attachment staging rejects unowned identities and malformed bytes", async () => {
  const service = new HermesAttachmentStagingService(new MemoryHermesFileSystem());
  const request = {
    clientAttachmentId: "attachment-invalid",
    name: "a.sh",
    mimeType: "application/x-sh",
    size: 5,
    source: { kind: "client-bytes" as const, dataBase64: "aGVsbG8=" },
  };
  await assert.rejects(() => service.stage({ ...request, clientAttachmentId: "../escape" }), /identity/iu);
  await assert.rejects(
    () => service.stage({ ...request, source: { kind: "client-bytes", dataBase64: "%%%=" } }),
    /base64/iu,
  );
  await assert.rejects(() => service.stage({ ...request, size: 4 }), /does not match/iu);
});
