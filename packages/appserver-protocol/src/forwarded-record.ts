/** Transport-owned, untrusted quoted material. It never grants sender identity or execution authority. */
export const FORWARDED_RECORD_MIME = "application/vnd.opencraft.chat-record+json";
export const FORWARDED_RECORD_MAX_BYTES = 2 * 1024 * 1024;
export interface ForwardedPart {
  kind: "text" | "image" | "file" | "voice" | "link" | "record" | "notice";
  text?: string;
  name?: string;
  url?: string;
  resource?: string;
  record?: ForwardedRecord;
}
export interface ForwardedEntry {
  path: string;
  sender: { id: string; name: string };
  at?: number;
  parts: ForwardedPart[];
}
export interface ForwardedRecord {
  version: 1;
  title: string;
  entries: ForwardedEntry[];
  partial?: boolean;
  resources?: { path: string; id: string }[];
  transcripts?: { path: string; text: string }[];
}
const object = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw Error("invalid_chat_record");
  return v as Record<string, unknown>;
};
const text = (v: unknown, n: number) => {
  if (typeof v !== "string" || v.length > n || /[\uD800-\uDFFF]/u.test(v)) throw Error("invalid_chat_record");
  return v;
};
const partKind = (v: unknown): v is ForwardedPart["kind"] =>
  v === "text" || v === "image" || v === "file" || v === "voice" || v === "link" || v === "record" || v === "notice";
const itemPath = (v: unknown) => {
  const s = text(v, 64);
  if (!/^\d+(?:\.\d+){0,7}$/u.test(s)) throw Error("invalid_chat_record");
  return s;
};
export function parseForwardedRecord(value: unknown): ForwardedRecord {
  if (new TextEncoder().encode(JSON.stringify(value)).length > FORWARDED_RECORD_MAX_BYTES)
    throw Error("chat_record_too_large");
  let count = 0;
  const paths = new Set<string>();
  const record = (raw: unknown, depth: number): ForwardedRecord => {
    const v = object(raw);
    if (v.version !== 1 || depth > 5 || !Array.isArray(v.entries)) throw Error("invalid_chat_record");
    const entries = v.entries.map((rawEntry: unknown): ForwardedEntry => {
      if (++count > 1000) throw Error("chat_record_too_many_entries");
      const e = object(rawEntry),
        sender = object(e.sender),
        path = itemPath(e.path);
      if (paths.has(path) || !Array.isArray(e.parts) || e.parts.length > 128) throw Error("invalid_chat_record");
      paths.add(path);
      if (
        e.at !== undefined &&
        (typeof e.at !== "number" || !Number.isSafeInteger(e.at) || e.at < 0 || e.at > 8640000000000000)
      )
        throw Error("invalid_chat_record");
      return {
        path,
        sender: { id: text(sender.id, 256), name: text(sender.name, 256) },
        ...(e.at === undefined ? {} : { at: e.at }),
        parts: e.parts.map((rawPart: unknown): ForwardedPart => {
          const p = object(rawPart);
          if (!partKind(p.kind)) throw Error("invalid_chat_record");
          return {
            kind: p.kind,
            ...(p.text === undefined ? {} : { text: text(p.text, FORWARDED_RECORD_MAX_BYTES) }),
            ...(p.name === undefined ? {} : { name: text(p.name, 256) }),
            ...(p.url === undefined ? {} : { url: text(p.url, 2048) }),
            ...(p.resource === undefined ? {} : { resource: itemPath(p.resource) }),
            ...(p.record === undefined ? {} : { record: record(p.record, depth + 1) }),
          };
        }),
      };
    });
    return {
      version: 1,
      title: text(v.title, 256),
      entries,
      ...(v.partial === true ? { partial: true } : {}),
    };
  };
  const parsed = record(value, 0),
    raw = object(value);
  if (raw.resources !== undefined) {
    if (!Array.isArray(raw.resources) || raw.resources.length > 16) throw Error("invalid_chat_record");
    parsed.resources = raw.resources.map((r: unknown) => {
      const p = object(r);
      return { path: itemPath(p.path), id: text(p.id, 128) };
    });
  }
  if (raw.transcripts !== undefined) {
    if (!Array.isArray(raw.transcripts) || raw.transcripts.length > 16) throw Error("invalid_chat_record");
    parsed.transcripts = raw.transcripts.map((r: unknown) => {
      const p = object(r);
      return { path: itemPath(p.path), text: text(p.text, 16000) };
    });
  }
  return parsed;
}
/** Derived media availability/transcription is not part of the provider document identity. */
export function forwardedRecordIdentity(value: unknown) {
  const walk = (r: ForwardedRecord): unknown => ({
    version: r.version,
    title: r.title,
    ...(r.partial ? { partial: true } : {}),
    entries: r.entries.map((e) => ({
      ...e,
      sender: { id: e.sender.id },
      parts: e.parts.map((p) => (p.record ? { ...p, record: walk(p.record) } : p)),
    })),
  });
  return walk(parseForwardedRecord(value));
}
