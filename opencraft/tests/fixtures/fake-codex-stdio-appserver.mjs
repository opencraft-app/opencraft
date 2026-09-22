import readline from "node:readline";

const input = readline.createInterface({ input: process.stdin });
let initialized = 0;
const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
input.on("line", line => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    initialized += 1;
    send({ id: message.id, result: { codexHome: process.env.CODEX_HOME, platformFamily: "unix", platformOs: "darwin", userAgent: "fake", serverInfo: { name: "fake-codex", version: String(initialized) } } });
    return;
  }
  if (message.method === "initialized") return;
  if (message.method === "thread/start") {
    const thread = { id: "codex-thread-1", preview: "", ephemeral: false, modelProvider: "opencraft-account-pool", createdAt: 1, updatedAt: 1, status: { type: "idle" }, turns: [] };
    send({ id: message.id, result: { thread, model: "gpt-test", modelProvider: "opencraft-account-pool", cwd: message.params.cwd, approvalPolicy: "never", approvalsReviewer: "user", sandbox: { type: "dangerFullAccess" }, serviceTier: null } });
    send({ method: "thread/started", params: { thread } });
    send({ id: 900, method: "item/tool/requestUserInput", params: { threadId: thread.id, turnId: null, itemId: "question-1", questions: [] } });
    return;
  }
  if (message.id === 900 && (message.result || message.error)) {
    send({ method: "serverRequest/resolved", params: { threadId: "codex-thread-1", requestId: 900 } });
    return;
  }
  send({ id: message.id, result: {} });
});
