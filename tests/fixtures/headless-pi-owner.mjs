// A real Headless server whose Pi engine runs in this process, so the `pi-owner`
// lock is held by a separate process that a test can stop or kill.
import { startHeadlessServer } from "../../apps/headless-server/src/headless-server.mjs";

const options = JSON.parse(process.argv[2]);
const app = await startHeadlessServer({
  ...options,
  startAgentHost: async () => ({ websocketUrl: "ws://127.0.0.1:9/rpc", close: async () => {} }),
});
process.send({ type: "ready", url: app.url });
process.on("message", async (message) => {
  if (message?.type !== "close") return;
  await app.close();
  process.send({ type: "closed" });
  process.disconnect();
});
