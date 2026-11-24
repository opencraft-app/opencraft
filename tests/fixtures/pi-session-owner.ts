// A native Pi session owner in its own process, for cross-process writer tests.
import { dirname } from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { PiDurableSession } from "../../plugins/pi-engine/src/session.js";

const file = process.argv[2]!;
const session = await PiDurableSession.open({
  threadId: "pi_owner_fixture",
  cwd: dirname(file),
  file,
  agentDirectory: dirname(file),
  shell: false,
  lockRetries: 0,
  models: createModels() as unknown as ModelRuntime,
  tools: [],
  onSnapshot() {},
  async onTool() {
    throw new Error("Unexpected tool");
  },
  onExit(error) {
    process.send!({ type: "exit", message: error.message });
  },
});
process.on("message", async (message: { type: string; id: string }) => {
  if (message.type !== "write") return;
  try {
    await session.recordRecovery(message.id, message.id);
    process.send!({ type: "written", id: message.id });
  } catch (error) {
    process.send!({ type: "refused", id: message.id, message: (error as Error).message });
  }
});
process.send!({ type: "ready" });
setInterval(() => {}, 1000);
