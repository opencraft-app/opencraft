import { randomUUID } from "node:crypto";
import { mkdir, open, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentConversationContinuation } from "@opencraft/appserver-protocol";

/** Called only by the native history Worker; large transcript serialization
 * must not run on the Host's connection/message event loop. */
export async function exportConversationContext(directory: string, threadId: string, title: string | null, cwd: string,
  turns: readonly { id: string; items?: readonly Record<string, any>[] }[]): Promise<AgentConversationContinuation> {
  if (!isAbsolute(directory) || !isAbsolute(cwd)) throw new Error("Conversation context storage is unavailable");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const id = randomUUID(), transcriptPath = join(directory, `${id}.md`), archivePath = join(directory, `${id}.jsonl`);
  const transcript = await open(transcriptPath, "wx", 0o600);
  let archive: Awaited<ReturnType<typeof open>> | undefined;
  const text = (value: unknown): string => typeof value === "string" ? value : Array.isArray(value)
    ? value.map(part => typeof part === "string" ? part : part && typeof part.text === "string" ? part.text : "").filter(Boolean).join("\n") : "";
  let completed = false;
  try {
    archive = await open(archivePath, "wx", 0o600);
    await transcript.writeFile(`# ${title ?? threadId}\n\nSource: ${threadId}\nWorkspace: ${cwd}\nFull structured record: ${archivePath}\n\n`);
    for (const turn of turns) {
      await archive.writeFile(JSON.stringify(turn) + "\n");
      await transcript.writeFile(`## Turn ${turn.id}\n\n`);
      for (const item of turn.items ?? []) {
        if (item.type !== "userMessage" && item.type !== "agentMessage") continue;
        const content = text(item.text ?? item.content);
        if (content) await transcript.writeFile(`### ${item.type === "userMessage" ? "User" : "Assistant"}\n\n${content}\n\n`);
      }
    }
    await transcript.sync(); await archive.sync();
    completed = true;
    return { id, sourceThreadId: threadId, title, cwd, uri: pathToFileURL(transcriptPath).href, transcriptPath, archivePath, turnCount: turns.length };
  } finally {
    try { await transcript.close(); await archive?.close(); }
    finally { if (!completed) await Promise.allSettled([rm(transcriptPath, { force: true }), rm(archivePath, { force: true })]); }
  }
}
