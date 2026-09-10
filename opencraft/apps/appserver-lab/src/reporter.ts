export interface LabClock {
  now(): number;
}

export interface LabWriter {
  write(line: string): void;
}

export interface LabEvent {
  sequence: number;
  timestampMs: number;
  event: string;
  [field: string]: unknown;
}

function jsonSafe(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "bigint") return String(value);
  if (typeof value === "function") return `[Function ${value.name || "anonymous"}]`;
  if (typeof value === "symbol") return String(value);
  if (value === undefined) return null;
  if (typeof value !== "object" || value === null) return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  const safe = value instanceof Error
    ? {
        name: value.name,
        message: value.message,
        ...("code" in value ? { code: jsonSafe(value.code, seen) } : {}),
      }
    : Array.isArray(value)
      ? value.map((item) => jsonSafe(item, seen))
      : Object.fromEntries(
          Object.entries(value).map(([key, item]) => [key, jsonSafe(item, seen)]),
        );
  seen.delete(value);
  return safe;
}

export function preview(value: unknown, maxCharacters = 2_000): unknown {
  const safe = jsonSafe(value);
  const serialized = JSON.stringify(safe);
  if (serialized === undefined) return null;
  if (serialized.length <= maxCharacters) return safe;
  return {
    truncated: true,
    characters: serialized.length,
    preview: serialized.slice(0, maxCharacters),
  };
}

export class NdjsonReporter {
  private sequence = 0;

  constructor(
    private readonly writer: LabWriter,
    private readonly clock: LabClock = { now: () => Date.now() },
  ) {}

  emit(event: string, fields: Readonly<Record<string, unknown>> = {}): LabEvent {
    const entry: LabEvent = {
      sequence: ++this.sequence,
      timestampMs: this.clock.now(),
      event,
      ...Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, jsonSafe(value)])),
    };
    this.writer.write(`${JSON.stringify(entry)}\n`);
    return entry;
  }
}
