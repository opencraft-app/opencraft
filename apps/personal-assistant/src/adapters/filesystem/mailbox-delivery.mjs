import { join } from "node:path";
import { digest, stable } from "../../domain/values.mjs";
import { publishOnce } from "./atomic-file.mjs";
export class LocalMailboxDelivery {
  constructor(directory, { afterWrite = () => {} } = {}) {
    this.directory = directory;
    this.afterWrite = afterWrite;
  }
  deliver(d) {
    if (process.env.LAB_TEST_DELIVERY_FAIL === "1") throw new Error("Injected local mailbox failure");
    publishOnce(
      join(this.directory, `${digest(d.id)}.json`),
      stable({
        deliveryId: d.id,
        resultId: d.result_id,
        workId: d.work_id,
        revision: d.revision,
        text: d.text,
        ...(d.user_message_json ? { message: JSON.parse(d.user_message_json) } : {}),
      }) + "\n",
    );
    this.afterWrite();
  }
}
