import { createHash } from "node:crypto";
import { join } from "node:path";
import type { SshCodexServerBinding } from "./ssh-codex-connections.js";
import { SshFileTransfer } from "./ssh-file-transfer.js";

/** Shared by the source factory and a narrowly applied runtime upgrade. */
export function createSshAttachmentOptions(binding: SshCodexServerBinding, stateDirectory?: string) {
  if (!stateDirectory) return {};
  const connection = binding.connection;
  const namespace = createHash("sha256").update(JSON.stringify([
    binding.descriptor.serverId, connection.hostname, connection.port, connection.username,
    connection.codexHome ?? null, connection.socketPath ?? null,
  ])).digest("hex");
  const directory = join(stateDirectory, "ssh-servers", namespace);
  return {
    attachments: { directory: join(directory, "attachments"), namespace, files: new SshFileTransfer({ connection }) },
    attachmentHistoryDirectory: directory,
  };
}
