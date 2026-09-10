import type { RealtimeTranscriptEntry } from "./timeline";

export const REALTIME_DELEGATION_ID_PREFIX = "realtime-delegation-";

export interface RealtimeDelegation {
  readonly input: string;
  readonly source: "transcript_tail_flush" | null;
  readonly transcript: readonly RealtimeTranscriptEntry[];
  readonly transcriptDelta: string | null;
}

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function decodeXmlText(value: string): string {
  // This order is intentional: it matches Codex and avoids decoding a value
  // such as `&amp;lt;` twice.
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", "\"")
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

function tagContent(value: string, tagName: string): string | null {
  const match = new RegExp(`<${tagName}>\\s*([\\s\\S]*?)\\s*</${tagName}>`, "i").exec(value);
  return match?.[1] === undefined ? null : decodeXmlText(match[1].trim());
}

function parseTranscriptHistory(value: string | null, input: string): readonly RealtimeTranscriptEntry[] {
  const entries: RealtimeTranscriptEntry[] = [];
  let current: RealtimeTranscriptEntry | null = null;
  for (const line of value?.split(/\r?\n/u) ?? []) {
    const roleLine = /^(user|assistant):\s?(.*)$/iu.exec(line);
    if (roleLine !== null) {
      if (current !== null && current.text.trim().length > 0) {
        entries.push({ ...current, text: current.text.trim() });
      }
      current = {
        role: roleLine[1]?.toLocaleLowerCase() === "user" ? "user" : "assistant",
        text: roleLine[2] ?? "",
      };
      continue;
    }
    if (current !== null) current = { ...current, text: `${current.text}\n${line}` };
  }
  if (current !== null && current.text.trim().length > 0) {
    entries.push({ ...current, text: current.text.trim() });
  }
  const last = entries.at(-1);
  if (last?.role !== "user" || last.text !== input) entries.push({ role: "user", text: input });
  return entries;
}

/** Extract only Composer text parts; attachments are not delegation markup. */
export function realtimeDelegationText(value: unknown): string {
  const values = Array.isArray(value) ? value : value == null ? [] : [value];
  return values.flatMap((entry): string[] => {
    if (typeof entry === "string") return [entry];
    const source = record(entry);
    return source?.type === "text" && typeof source.text === "string" ? [source.text] : [];
  }).join("\n");
}

/** Source-equivalent parser for Codex's private realtime handoff envelope. */
export function parseRealtimeDelegation(value: unknown): RealtimeDelegation | null {
  const payload = realtimeDelegationText(value).trim();
  if (!payload.startsWith("<realtime_delegation>") || !payload.endsWith("</realtime_delegation>")) return null;
  const input = tagContent(payload, "input");
  if (input === null) return null;
  const transcriptDelta = tagContent(payload, "transcript_delta");
  return {
    input,
    source: tagContent(payload, "source") === "transcript_tail_flush" ? "transcript_tail_flush" : null,
    transcript: parseTranscriptHistory(transcriptDelta, input),
    transcriptDelta,
  };
}

export function realtimeDelegationHandoffId(itemId: string): string | null {
  return itemId.startsWith(REALTIME_DELEGATION_ID_PREFIX)
    ? itemId.slice(REALTIME_DELEGATION_ID_PREFIX.length)
    : null;
}
