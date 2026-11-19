import { join } from "node:path";
import { digest } from "../../domain/values.mjs";
import { publishOnce } from "./atomic-file.mjs";
import { createHash } from "node:crypto";
export class LocalArtifactStore {
  constructor(directory, attachments = null) {
    this.directory = directory;
    this.attachments = attachments;
  }
  publishNote(executionId, body) {
    return {
      ...publishOnce(join(this.directory, `${digest(executionId)}.md`), body),
      sha256: createHash("sha256").update(body).digest("hex"),
      bytes: Buffer.byteLength(body),
      ...(this.attachments
        ? {
            attachment: this.attachments.importBytes(`${digest(executionId)}.md`, Buffer.from(body)),
          }
        : {}),
    };
  }
}
