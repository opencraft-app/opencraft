export function parseSseJsonFrames(chunk: string): unknown[] {
  const frames: unknown[] = [];
  for (const frame of chunk.split(/\n\n+/)) {
    const dataLines = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trimStart());
    if (dataLines.length === 0) continue;
    frames.push(JSON.parse(dataLines.join("\n")));
  }
  return frames;
}
