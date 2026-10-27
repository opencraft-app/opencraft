import { WebSocketServer } from "ws";

// A test-owned physical endpoint. Restarting it cannot affect a user Host.
const server = new WebSocketServer({ host: "127.0.0.1", port: Number(process.env.FIXTURE_PORT ?? 0) });
const thread = (id: string) => ({ id, name: id === "pin-target" ? "Lifecycle recovery fixture" : "Other conversation",
  preview: "", cwd: "/fixture", path: "/fixture/history", createdAt: 2, updatedAt: 2, status: { type: "idle" }, turns: [] });
server.on("connection", socket => socket.on("message", frame => {
  const request = JSON.parse(String(frame));
  if (request.id === undefined) return;
  process.send?.({ method: request.method });
  const send = (result: unknown) => socket.send(JSON.stringify({ id: request.id, result }));
  switch (request.method) {
    case "initialize": send({ codexHome: "/fixture", platformFamily: "unix", platformOs: "linux", userAgent: "recovery-fixture" }); break;
    case "thread/list": send({ data: [thread("pin-target"), thread("other")], nextCursor: null }); break;
    case "model/list": send({ data: [{ id: "fixture", model: "fixture", displayName: "Fixture", isDefault: true,
      inputModalities: ["text"], supportedReasoningEfforts: [], defaultReasoningEffort: null }], nextCursor: null }); break;
    case "config/read": send({ config: { model: "fixture", model_provider: "fixture" }, origins: {} }); break;
    case "permissionProfile/list": send({ data: [{ id: "workspace", description: "Workspace", allowed: true }], nextCursor: null }); break;
    case "thread/unsubscribe": send({ status: "unsubscribed" }); break;
    default: send(request.method.endsWith("/list") ? { data: [], nextCursor: null } : {});
  }
}));
server.once("listening", () => process.send?.({ port: (server.address() as { port: number }).port }));
process.on("SIGTERM", () => { for (const socket of server.clients) socket.terminate(); server.close(() => process.exit(0)); });
