import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { digest, stable } from "../../domain/values.mjs";
import { publishOnce } from "./atomic-file.mjs";

export class LocalMessageDelivery {
  constructor(directory, attachments, { afterWrite = () => {} } = {}) {
    Object.assign(this, { directory, attachments, afterWrite });
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  async deliver(message) {
    if (process.env.LAB_TEST_MESSAGE_FAIL === "1") throw new Error("Injected user message failure");
    const files = (message.body.files ?? []).map((f) =>
      this.attachments.materialize(f.attachmentId, join(this.directory, "assets")),
    );
    const file = `${digest(message.id)}.json`;
    publishOnce(
      join(this.directory, file),
      stable({
        messageId: message.id,
        conversationId: message.conversation_id,
        body: message.body,
        files,
      }) + "\n",
    );
    this.afterWrite();
    return {
      messageId: message.id,
      channel: message.body.channel,
      level: "accepted",
      remoteId: file,
    };
  }
}
