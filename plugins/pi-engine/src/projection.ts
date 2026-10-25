import { CompactionEntry, UserEntry } from "@earendil-works/pi-durable";
import type { PiSnapshot } from "./session.js";

type Value = Record<string, any>;
export type PiTurn = Value & { id: string };
export const textOf = (content: any): string => typeof content === "string" ? content : (content ?? []).filter((part: Value) => part.type === "text").map((part: Value) => part.text).join("\n");
const errorOf = (message: string) => ({ message, codexErrorInfo: null, additionalDetails: null });
function outputItems(content: Value[] = []) {
  return content.map(part => {
    if (part.type === "text") return { type: "inputText", text: part.text };
    if (part.type === "image") return { type: "inputImage", imageUrl: `data:${part.mimeType};base64,${part.data}` };
    return { type: "inputText", text: `Unsupported native tool output: ${String(part.type)}` };
  });
}
export function toolItem(session: { cwd: string; tools: Value[] }, id: string, name: string, args: Value): Value {
  const tool = session.tools.find(tool => tool.piName === name);
  if (!tool && name === "bash") return { type: "commandExecution", id, pluginId: null, scriptPath: null,
    command: args.command ?? "", cwd: session.cwd, processId: null, source: "agent", commandActions: [],
    status: "inProgress", aggregatedOutput: null, exitCode: null, durationMs: null };
  return { type: "dynamicToolCall", id, namespace: tool?.namespace ?? null, tool: tool?.name ?? name,
    arguments: args, status: "inProgress", contentItems: null, success: null, durationMs: null };
}
function assistantItems(base: string, message: Value): Value[] {
  const items: Value[] = [];
  const reasoning = (message.content ?? []).filter((part: Value) => part.type === "thinking").map((part: Value) => part.thinking);
  if (reasoning.length) items.push({ type: "reasoning", id: `${base}:thinking`, summary: [], content: reasoning });
  const text = textOf(message.content);
  if (text) items.push({ type: "agentMessage", id: `${base}:text`, text, phase: message.stopReason === "toolUse" ? "commentary" : null,
    memoryCitation: null, delivery: null, questions: null });
  return items;
}

/** The same native projection serves stream delivery, read, Resume and process recovery. */
export function projectPiSnapshot(session: { id: string; cwd: string; tools: Value[] }, snapshot: PiSnapshot): PiTurn[] {
  const submissions = new Map(snapshot.submissions.filter(s => s.type === "input" && s.entry !== undefined).map(s => [s.entry, s]));
  const steerMetadata = new Map(snapshot.entries.filter(entry => entry.kind === "opencraft.steerAdmission")
    .map(entry => [(entry.data as Value).turnId, entry.data as Value]));
  const tasks = snapshot.tasks;
  const turns: PiTurn[] = [];
  const taskGroups = new Map<Value, Set<number>>();
  const grouped = new Map<string, PiTurn>();
  const states = new Map<PiTurn, Value[]>();
  const counts = new Map<number | string, number>();
  const callItems = new Map<string, Value>();
  let turn: Value | undefined;
  const makeTurn = (submission: Value | undefined, entryId: number | string, message: Value, metadata: Value = {}) => {
    const id = metadata.steerTurnId ?? submission?.requestId ?? metadata.turnId ?? `${session.id}:input:${entryId}`;
    const state = submission?.status;
    const status = state === "queued" || state === "placed" ? "inProgress" : state === "unanswered"
      ? submission?.reason === "aborted" ? "interrupted" : "failed" : "completed";
    const createdAt = metadata.createdAtMs ?? message.timestamp;
    const result: PiTurn = { id, items: [{ type: "userMessage", id: `${id}:user`,
      clientId: metadata.clientId ?? (id.startsWith(`${session.id}:turn:client:`) ? id.slice(`${session.id}:turn:client:`.length) : null),
      ...(metadata.steerTurnId ? { __opencraftMessageKind: "steering", __opencraftSteeringStatus: submission?.entry !== undefined ? "accepted" : state === "unanswered" ? "cancelled" : "pending", deliveryStatus: "sent" } : {}),
      content: metadata.input ?? [{ type: "text", text: textOf(message.content), text_elements: [] }] }],
      itemsView: "complete", status, error: status === "failed" ? errorOf(String(submission?.detail ?? submission?.reason ?? "Pi input failed")) : null,
      startedAt: typeof createdAt === "number" ? Math.floor(createdAt / 1000) : null, completedAt: null, durationMs: null };
    const existing = grouped.get(id);
    if (existing) {
      const item = result.items[0];
      item.id = `${submission?.requestId ?? metadata.turnId ?? entryId}:user`;
      existing.items.push(item);
      if (submission) states.get(existing)!.push(submission);
      return existing;
    }
    turns.push(result); grouped.set(id, result); states.set(result, submission ? [submission] : []);
    taskGroups.set(result, new Set()); return result;
  };
  for (const entry of snapshot.entries) {
    // Compaction contributes a user-role summary to MODEL context, not a new
    // user input. Its independent task must not extend a completed Turn's time.
    if (CompactionEntry.is(entry)) {
      if (turn) turn.items.push({ type: "contextCompaction", id: `${session.id}:compaction:${entry.id}` });
      continue;
    }
    let messageIndex = 0;
    for (const message of entry.model ?? []) {
      if (message.role === "user" && (submissions.has(entry.id) || UserEntry.is(entry) || entry.kind === "opencraft.input")) turn = makeTurn(submissions.get(entry.id), entry.id, message, entry.kind === "opencraft.input" ? entry.data as Value : {});
      else if (turn && message.role === "assistant") {
        const key = entry.byTaskId ?? `entry-${entry.id}`;
        const ordinal = counts.get(key) ?? 0; counts.set(key, ordinal + 1);
        const base = `${session.id}:generation:${key}:${ordinal}:${messageIndex}`;
        turn.items.push(...assistantItems(base, message));
        for (const tool of message.content.filter(part => part.type === "toolCall")) {
          const item = toolItem(session, tool.id, tool.name, tool.arguments); turn.items.push(item); callItems.set(tool.id, item);
        }
      } else if (turn && message.role === "toolResult") {
        const item = callItems.get(message.toolCallId);
        if (item) {
          item.status = message.isError ? "failed" : "completed";
          if (item.type === "commandExecution") item.aggregatedOutput = textOf(message.content);
          else { item.success = !message.isError; item.contentItems = outputItems(message.content); }
          const task = entry.byTaskId === undefined ? undefined : tasks.get(entry.byTaskId);
          if (task?.startedAt != null && task.endedAt != null) item.durationMs = Math.max(0, task.endedAt - task.startedAt);
        }
      }
      if (turn && entry.byTaskId !== undefined) taskGroups.get(turn)!.add(entry.byTaskId);
      messageIndex++;
    }
  }
  // Queued inputs exist in the durable inbox before they have a transcript entry.
  for (const submission of snapshot.submissions) {
    if (submission.type !== "input" || submission.entry !== undefined) continue;
    const queued = snapshot.inbox.find(item => item.id === submission.id);
    const metadata = queued?.entry?.data ?? steerMetadata.get(submission.requestId);
    if (!metadata?.steerTurnId) continue;
    makeTurn(submission, submission.id, { content: queued?.content }, metadata);
  }
  for (const candidate of turns) {
    const records = states.get(candidate)!;
    if (records.some(record => record.status === "queued" || record.status === "placed")) {
      candidate.status = "inProgress"; candidate.error = null;
    } else {
      const failed = records.find(record => record.status === "unanswered" && (record.requestId === candidate.id || record.entry !== undefined));
      if (failed) {
        candidate.status = failed.reason === "aborted" ? "interrupted" : "failed";
        candidate.error = candidate.status === "failed" ? errorOf(String(failed.detail ?? failed.reason ?? "Pi input failed")) : null;
      }
    }
  }
  const active = [...turns].reverse().find(candidate => candidate.status === "inProgress");
  const live = snapshot.live;
  if (active && live.generation?.message && live.run) {
    const ordinal = counts.get(live.run.taskId) ?? 0;
    active.items.push(...assistantItems(`${session.id}:generation:${live.run.taskId}:${ordinal}:0`, live.generation.message));
    taskGroups.get(active)!.add(live.run.taskId);
  }
  if (active && live.run) taskGroups.get(active)!.add(live.run.taskId);
  for (const slot of live.tools ?? []) {
    const item = callItems.get(slot.callId);
    if (!item) continue;
    if (slot.output !== undefined) {
      if (item.type === "commandExecution") item.aggregatedOutput = slot.output;
      else item.contentItems = [{ type: "inputText", text: slot.output }];
    }
    if (slot.status === "done" && item.status === "inProgress") { item.status = "failed"; if (item.type === "dynamicToolCall") item.success = false; }
    if (slot.taskId !== undefined && active) taskGroups.get(active)!.add(slot.taskId);
  }
  for (const candidate of turns) {
    const records = [...taskGroups.get(candidate)!].flatMap(id => tasks.get(id) ? [tasks.get(id)!] : []);
    const starts = records.flatMap(task => task.startedAt == null ? [] : [task.startedAt]);
    const ends = records.flatMap(task => task.endedAt == null ? [] : [task.endedAt]);
    const start = starts.length ? Math.min(...starts) : null;
    if (start != null) candidate.startedAt = Math.floor(start / 1000);
    if (candidate.status !== "inProgress" && start != null && ends.length) {
      const end = Math.max(...ends); candidate.completedAt = Math.floor(end / 1000); candidate.durationMs = Math.max(0, end - start);
    }
    if (candidate.status !== "inProgress") for (const item of candidate.items) {
      if (item.status === "inProgress") { item.status = "failed"; if (item.type === "dynamicToolCall") item.success = false; }
    }
  }
  return turns;
}
export function tokenUsage(snapshot: PiSnapshot, contextWindow: number | null) {
  const sum = (values: Value[]) => values.reduce((total, usage) => {
    total.inputTokens += usage.input ?? 0; total.outputTokens += usage.output ?? 0;
    total.cachedInputTokens += usage.cacheRead ?? 0; total.cacheWriteInputTokens += usage.cacheWrite ?? 0;
    total.reasoningOutputTokens += usage.reasoning ?? 0;
    total.totalTokens += usage.totalTokens ?? (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
    return total;
  }, { totalTokens: 0, inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 });
  const last = [...snapshot.entries].reverse().flatMap(entry => entry.model ?? []).find(message => message.role === "assistant");
  return { total: sum([...Object.values(snapshot.usage.models ?? {}), ...Object.values(snapshot.usage.tools ?? {})]),
    last: sum(last && "usage" in last ? [last.usage] : []), modelContextWindow: contextWindow };
}
