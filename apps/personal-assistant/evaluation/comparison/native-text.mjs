import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeCodexSession, nativeUsage } from "../../src/adapters/codex/native-session.mjs";
export async function nativeText(config, { instruction, messages, signal, schema, tools = [], execute }) {
  const root = await mkdtemp(join(tmpdir(), "memory-compare-"));
  let toolCalls = 0;
  let session,
    threadId,
    turnId,
    text = "",
    usage,
    resolveTurn,
    rejectTurn,
    early = [];
  const event = (p) => {
    const v = p.params;
    if ((v.turnId ?? v.turn?.id) !== turnId) return;
    if (p.method === "item/completed" && v.item?.type === "agentMessage" && v.item.phase !== "commentary")
      text = v.item.text;
    if (p.method === "turn/completed")
      v.turn.status === "completed"
        ? resolveTurn?.()
        : rejectTurn?.(
            Object.assign(
              new Error("Native turn " + v.turn.status + (v.turn.error?.message ? ": " + v.turn.error.message : "")),
              { nativeError: v.turn.error ?? null },
            ),
          );
  };
  try {
    session = await NativeCodexSession.open(config, {
      home: join(root, "home"),
      cwd: join(root, "empty"),
      signal,
      onRequest: async (p) => {
        if (p.method !== "item/tool/call" || p.params.threadId !== threadId)
          throw new Error("Unexpected native tool request");
        if (++toolCalls > 20) throw new Error("Native tool-call budget exceeded");
        const result = await execute(p.params.tool, p.params.arguments);
        return {
          contentItems: [
            {
              type: "inputText",
              text: typeof result === "string" ? result : JSON.stringify(result),
            },
          ],
          success: true,
        };
      },
      onFailure: (e) => rejectTurn?.(e),
      onNotification: (p) => {
        if (p.params?.threadId !== threadId) return;
        if (p.method === "thread/tokenUsage/updated") usage = p.params.tokenUsage?.total ?? usage;
        if (["item/completed", "turn/completed"].includes(p.method)) turnId ? event(p) : early.push(p);
      },
    });
    const start = await session.rpc("thread/start", {
      model: config.modelId,
      cwd: join(root, "empty"),
      ephemeral: true,
      approvalPolicy: "never",
      sandbox: "read-only",
      baseInstructions: instruction,
      developerInstructions: tools.length
        ? "Use only the supplied dynamic tools and the original task protocol."
        : "Use only the supplied model protocol. No direct host tools are available.",
      dynamicTools: tools,
    });
    threadId = start.thread.id;
    const completed = new Promise((r, j) => {
      resolveTurn = r;
      rejectTurn = j;
    });
    completed.catch(() => {});
    const accepted = await session.rpc("turn/start", {
      threadId,
      input: [{ type: "text", text: JSON.stringify(messages), text_elements: [] }],
      ...(schema ? { outputSchema: schema } : {}),
    });
    turnId = accepted.turn?.id;
    if (!turnId) throw new Error("Missing native turn");
    early.forEach(event);
    early = [];
    await completed;
    signal.throwIfAborted();
    return { text, usage: nativeUsage(usage), toolCalls };
  } catch (e) {
    e.usage = nativeUsage(usage);
    throw e;
  } finally {
    await session?.close();
    await rm(root, { recursive: true, force: true });
  }
}
