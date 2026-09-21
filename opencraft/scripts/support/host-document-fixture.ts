import { createServer } from "node:http";
import { WebSocketServer } from "ws";

/** Engine handshake only; document traffic goes to the real Host, never to this fixture. */
export async function startDocumentTestEngine() {
  const server = createServer(async (request, response) => {
    let text = ""; for await (const chunk of request) text += chunk;
    const envelope = JSON.parse(text);
    if (envelope.method !== "host.describe") { response.writeHead(400); response.end(); return; }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ type: "server-response", rpcId: envelope.rpcId, result: { ok: true, value: { home: "/tmp/fixture", cwd: "/tmp/fixture", version: "fixture" } } }));
  });
  const sockets = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => sockets.handleUpgrade(request, socket, head, peer => sockets.emit("connection", peer)));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    async close() { for (const peer of sockets.clients) peer.terminate(); sockets.close(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}
