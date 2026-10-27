import { MemoryTransport, type InMemoryAppServerPeer } from "@opencraft/appserver-transport-memory";
import { encodeJsonRpcMessage, isJsonRpcRequest, parseJsonRpcMessage } from "@opencraft/appserver-protocol";

export const flush = async () => { for (let i = 0; i < 6; i++) await new Promise<void>(r => setImmediate(r)); };
export function executionChannelsFixture(schedule?: (run: () => void) => void) {
  let peer!: InMemoryAppServerPeer;
  let model = "old", reads = 0, activations = 0, hold = false;
  const held: (() => void)[] = [], replies: unknown[] = [];
  const thread = () => ({ id: "a", sessionId: "a", cwd: "/workspace", model, modelProvider: "fixture", historyMode: "message-window", turns: [] });
  const transport = new MemoryTransport({ ...(schedule ? { schedule } : {}), server: { receive(frame, current) {
    peer = current; const request = parseJsonRpcMessage(frame);
    if (!isJsonRpcRequest(request)) { if ("id" in request) replies.push(request); return; }
    const send = (result: unknown) => current.send(encodeJsonRpcMessage({ id: request.id, result }));
    if (request.method === "initialize") send({ codexHome: "/fixture", platformFamily: "unix", platformOs: "linux", userAgent: "execution-channels", capabilities: { extensions: { "opencraft/read-history": { version: 1 } } } });
    else if (request.method === "thread/read") {
      reads++; const result = { thread: thread(), initialTurnsPage: { data: [], nextCursor: null } };
      if (hold) held.push(() => send(result)); else send(result);
    } else if (request.method === "thread/resume") {
      activations++; const result = { thread: thread(), model, modelProvider: "fixture", cwd: "/workspace", runtimeWorkspaceRoots: [], approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: {}, streamRole: { role: "owner" } };
      if (hold) held.push(() => send(result)); else send(result);
    } else if (request.method === "thread/unarchive") {
      const result = { thread: thread() }; if (hold) held.push(() => send(result)); else send(result);
    } else send(request.method.endsWith("/list") ? { data: [], nextCursor: null } : {});
  } } });
  const emit = (method: string, params: unknown) => peer.send(encodeJsonRpcMessage({ method, params }));
  return { transport, replies, held, get reads() { return reads; }, get activations() { return activations; },
    set hold(value: boolean) { hold = value; }, emit,
    settings(value: string) { model = value; emit("thread/settings/updated", { threadId: "a", threadSettings: { model } }); },
    question(id: string | number = "question", itemId = "item") { peer.send(encodeJsonRpcMessage({ id, method: "item/tool/requestUserInput", params: { threadId: "a", turnId: "turn", itemId, questions: [{ id: "choice", header: "Choice", question: "Choose?", isOther: false, isSecret: false, options: null }] } })); },
    release() { for (const reply of held.splice(0)) reply(); },
  };
}
