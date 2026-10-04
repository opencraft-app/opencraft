import type { TimelineSourceItem } from "@opencraft/chat-core";

export function orderedResponseItems(streaming = false): TimelineSourceItem[] {
  const user = (id: string, text: string): TimelineSourceItem => ({ id, type: "userMessage",
    payload: { content: [{ type: "text", text }], clientId: `client:${id}` } });
  const text = (id: string, value: string, phase: string): TimelineSourceItem => ({ id, type: "agentMessage",
    payload: { text: value, phase, completed: id !== "answer3" || !streaming } });
  const command = (id: string): TimelineSourceItem => ({ id, type: "commandExecution",
    payload: { command: `echo ${id}`, status: "completed", exitCode: 0 } });
  const items = [user("initial", "Initial request"), command("work0"), {
    ...text("ask", "Question boundary", "final_answer"),
    payload: { text: "Question boundary", phase: "final_answer", delivery: "async", completed: true,
      questions: [{ title: "Question boundary", options: ["A", "B"] }] },
  }, user("reply", "Question reply"), command("work1"), text("old", "Older commentary", "commentary"),
  text("answer1", "First answer", "final_answer"), user("steer1", "First follow-up"),
  command("work2"), text("answer2", "Second answer", "final_answer"), user("steer2", "Second follow-up"),
  command("work3"), text("answer3", "Newest answer", "final_answer")];
  return items.map((item, index) => ({ ...item, payload: { ...(item.payload as Record<string, unknown>), startedAtMs: 1000 + index * 100 } }));
}
