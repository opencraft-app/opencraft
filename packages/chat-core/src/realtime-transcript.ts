import type { RealtimeTranscriptEntry } from "./timeline";

export const REALTIME_DELEGATION_ID_PREFIX = "realtime-delegation-";

export interface RealtimeDelegation {
  readonly input: string;
  readonly source: "transcript_tail_flush" | null;
  readonly transcript: readonly RealtimeTranscriptEntry[];
  readonly transcriptDelta: string | null;
}


export function realtimeDelegationText(value: unknown): string {
  if (typeof value === "string") return value;
  const parts: string[] = [];
  for (const part of Array.isArray(value) ? value : [value]) {
    if (typeof part === "string") parts.push(part);
    else if (part !== null && typeof part === "object" && part.type === "text" && typeof part.text === "string") {
      parts.push(part.text);
    }
  }
  return parts.join("\n");
}

const entities: Readonly<Record<string, string>> = {
  lt: "<", gt: ">", quot: '"', apos: "'", amp: "&",
};

function tagValue(body: string, name: string): string | null {
  const opening = `<${name}>`;
  const start = body.search(new RegExp(opening, "i"));
  if (start < 0) return null;
  const content = body.slice(start + opening.length);
  const end = content.search(new RegExp(`</${name}>`, "i"));
  if (end < 0) return null;
  return content.slice(0, end)
    .replace(/&(lt|gt|quot|apos|amp);/g, (_, entity: string) => entities[entity]!)
    .trim();
}

function transcriptEntries(delta: string | null, input: string): RealtimeTranscriptEntry[] {
  const result: RealtimeTranscriptEntry[] = [];
  let role: RealtimeTranscriptEntry["role"] | null = null;
  let lines: string[] = [];
  const finish = () => {
    const text = lines.join("\n").trim();
    if (role !== null && text.length > 0) result.push({ role, text });
  };
  for (const line of (delta ?? "").split(/\r?\n/)) {
    const marker = /^(user|assistant):\s?(.*)$/i.exec(line);
    if (marker) {
      finish();
      role = marker[1]!.toLowerCase() as RealtimeTranscriptEntry["role"];
      lines = [marker[2]!];
    } else if (role !== null) lines.push(line);
  }
  finish();
  const last = result.at(-1);
  if (last?.role !== "user" || last.text !== input) result.push({ role: "user", text: input });
  return result;
}

export function parseRealtimeDelegation(value: unknown): RealtimeDelegation | null {
  const text = realtimeDelegationText(value).trim();
  const opening = "<realtime_delegation>";
  const closing = "</realtime_delegation>";
  if (!text.startsWith(opening) || !text.endsWith(closing)) return null;
  const body = text.slice(opening.length, -closing.length);
  const input = tagValue(body, "input");
  if (input === null) return null;
  const transcriptDelta = tagValue(body, "transcript_delta");
  return {
    input,
    source: tagValue(body, "source") === "transcript_tail_flush" ? "transcript_tail_flush" : null,
    transcript: transcriptEntries(transcriptDelta, input),
    transcriptDelta,
  };
}

export function realtimeDelegationHandoffId(itemId: string): string | null {
  return itemId.startsWith(REALTIME_DELEGATION_ID_PREFIX)
    ? itemId.slice(REALTIME_DELEGATION_ID_PREFIX.length)
    : null;
}
