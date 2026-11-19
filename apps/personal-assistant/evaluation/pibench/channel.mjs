import { createInterface } from "node:readline";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { initProfile, loadProfile } from "../../src/profile.mjs";
import { LocalRunner } from "../../src/runtime/local-runner.mjs";
import { request } from "../../src/adapters/local/unix-socket.mjs";
import { pathToFileURL } from "node:url";

export function visibleReply(messages, after) {
  return messages
    .filter((m) => m.seq > after && m.role === "assistant" && !["acknowledgement", "progress"].includes(m.data?.kind))
    .map((m) => m.text)
    .filter(Boolean)
    .join("\n\n");
}
export function busy(status, conversation) {
  return Boolean(
    (!conversation && (status.active || status.receptionActive)) ||
      (conversation?.works ?? status.works).some((w) =>
        ["queued", "running", "awaiting_review", "awaiting_delivery"].includes(w.status),
      ),
  );
}

async function main() {
  const [modelProfile, output] = process.argv.slice(2);
  if (!modelProfile || !output) throw Error("Explicit model profile and output required");
  const source = loadProfile(modelProfile);
  if (
    source.config.mode !== "model" ||
    source.config.harnesses.assistant !== "codex" ||
    source.config.harnesses.execution !== "codex"
  )
    throw Error("Explicit all-Codex model profile required");
  const directory = await mkdtemp(join(tmpdir(), "sa-pib-"));
  const profile = initProfile(directory, "pibench-researcher", {
    mode: "model",
    harnesses: source.config.harnesses,
    concurrency: 2,
    memoryPolicy: source.config.memoryPolicy,
    runPolicy: { modelTimeoutMs: 60000, workTimeoutMs: 120000, maxSteps: 16 },
  });
  const runner = await LocalRunner.open(profile);
  const call = (op, params = {}, id = crypto.randomUUID()) => request(profile, { op, params, id });
  const exchanges = [];
  let conversationId = null;
  const conversations = [];
  const save = async () => {
    const evidence = {
      profileDirectory: directory,
      exchanges,
      conversations: [],
    };
    for (const id of conversations) evidence.conversations.push(await call("conversation", { conversationId: id }));
    for (const op of ["status", "conversation", "goal.list", "usage", "events"]) evidence[op] = await call(op);
    await writeFile(join(output, "product-evidence.json"), JSON.stringify(evidence, null, 2), { mode: 0o600 });
  };
  try {
    for await (const line of createInterface({ input: process.stdin })) {
      let reply;
      try {
        const input = JSON.parse(line);
        if (input.op === "reset") {
          ({ conversationId } = await call("conversation.create"));
          conversations.push(conversationId);
          reply = { content: "New session started" };
        } else if (input.op === "say") {
          if (
            !conversationId ||
            typeof input.content !== "string" ||
            Object.keys(input).some((k) => !["op", "content"].includes(k))
          )
            throw Error("Only visible user content is accepted");
          const before = await call("conversation", { conversationId });
          const cursor = Math.max(0, ...before.messages.map((m) => m.seq));
          const id = crypto.randomUUID();
          const record = {
            id,
            conversationId,
            input: input.content,
            startedAt: new Date().toISOString(),
          };
          exchanges.push(record);
          await call("say", { text: input.content, conversationId }, id);
          const end = Date.now() + 180000;
          let quietSince = 0;
          while (Date.now() < end) {
            const turn = await call("turn", { inputId: id });
            if (turn.status === "blocked") throw Error("Product reception blocked");
            const status = await call("status");
            const history = await call("conversation", { conversationId });
            const content = visibleReply(history.messages, cursor);
            if (turn.status === "settled" && !busy(status, history) && content) {
              quietSince ||= Date.now();
              if (Date.now() - quietSince >= 750) {
                reply = { content };
                record.reply = content;
                record.finishedAt = new Date().toISOString();
                break;
              }
            } else quietSince = 0;
            await delay(200);
          }
          if (!reply) throw Error("Product reply exceeded 180 seconds");
        } else throw Error("Unsupported channel operation");
        await save();
      } catch (error) {
        reply = { error: error.message };
        exchanges.push({ error: error.message });
        await save();
      }
      process.stdout.write(JSON.stringify(reply) + "\n");
    }
  } finally {
    await save();
    await runner.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
