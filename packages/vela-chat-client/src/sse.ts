export interface SseJsonFrame {
  event?: string;
  data: unknown;
}

export interface SseJsonFrameParser {
  push: (chunk: string) => SseJsonFrame[];
  finish: () => SseJsonFrame[];
}

export function createSseJsonFrameParser(): SseJsonFrameParser {
  let buffer = "";

  const drain = (includeTrailingFrame: boolean): SseJsonFrame[] => {
    const frames: SseJsonFrame[] = [];

    while (buffer.length > 0) {
      const separator = findFrameSeparator(buffer);
      if (!separator) {
        if (!includeTrailingFrame) break;
        const trailing = buffer;
        buffer = "";
        const parsedTrailing = parseSseJsonFrame(trailing);
        if (parsedTrailing) frames.push(parsedTrailing);
        break;
      }

      const frameText = buffer.slice(0, separator.index);
      buffer = buffer.slice(separator.index + separator.length);
      const parsed = parseSseJsonFrame(frameText);
      if (parsed) frames.push(parsed);
    }

    return frames;
  };

  return {
    push(chunk) {
      buffer += chunk;
      return drain(false);
    },
    finish() {
      return drain(true);
    },
  };
}

export function parseSseJsonFrames(chunk: string): unknown[] {
  return createSseJsonFrameParser().push(chunk).map((frame) => frame.data);
}

function findFrameSeparator(value: string): { index: number; length: number } | null {
  const match = /\r\n\r\n|\n\n|\r\r/.exec(value);
  if (!match) return null;
  return { index: match.index, length: match[0].length };
}

function parseSseJsonFrame(frameText: string): SseJsonFrame | null {
  const dataLines: string[] = [];
  let event: string | undefined;

  for (const line of frameText.split(/\r\n|\n|\r/)) {
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trim();
      continue;
    }
    if (line.startsWith("data:")) {
      dataLines.push(stripSingleLeadingSpace(line.slice("data:".length)));
    }
  }

  if (dataLines.length === 0) return null;
  return {
    ...(event ? { event } : {}),
    data: JSON.parse(dataLines.join("\n")),
  };
}

function stripSingleLeadingSpace(value: string) {
  return value.startsWith(" ") ? value.slice(1) : value;
}
