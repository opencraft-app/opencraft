import type { TimelineStatus, TurnDiffFileSummary, TurnDiffTimelineBlock } from "./timeline";


export interface TurnDiffSummary {
  readonly files: readonly TurnDiffFileSummary[];
  readonly additions: number;
  readonly deletions: number;
}

/** Git C-quotes bytes, including UTF-8 bytes, rather than JavaScript characters. */
function decodePath(wire: string): string {
  if (!wire.startsWith('"') || !wire.endsWith('"')) return wire;
  const text = wire.slice(1, -1);
  const escapes: Readonly<Record<string, string>> = {
    a: "\x07", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", '"': '"', "\\": "\\",
  };
  const parts: string[] = [];
  for (let index = 0; index < text.length; index++) {
    if (text[index] !== "\\") { parts.push(text[index]); continue; }
    const start = index;
    let bytes = "";
    while (text[index] === "\\" && /^[0-3][0-7]{2}$/u.test(text.slice(index + 1, index + 4))) {
      bytes += `%${Number.parseInt(text.slice(index + 1, index + 4), 8).toString(16).padStart(2, "0")}`;
      index += 4;
    }
    if (bytes !== "") {
      try { parts.push(decodeURIComponent(bytes)); }
      catch { parts.push(text.slice(start, index)); }
      index--;
    } else if (escapes[text[index + 1]] !== undefined) {
      parts.push(escapes[text[++index]]);
    } else {
      parts.push("\\");
    }
  }
  return parts.join("");
}

function sidePath(wire: string): string {
  return decodePath(wire).replace(/^[ab]\//u, "");
}

function destination(line: string): string | null {
  const body = line.slice("diff --git ".length);
  // Git leaves spaces unquoted. Equal sides also identify binary/mode-only files,
  // which have no ---/+++ metadata. The midpoint avoids ambiguous " b/" splits.
  const middle = (body.length - 1) / 2;
  if (Number.isInteger(middle) && body[middle] === " " && body.startsWith("a/")
    && body.slice(middle + 1, middle + 3) === "b/"
    && body.slice(2, middle) === body.slice(middle + 3)) return body.slice(middle + 3);
  if (/\s$/u.test(line)) return null;
  const words: string[] = [];
  let cursor = 0;
  while (cursor < body.length) {
    if (/\s/u.test(body[cursor])) { cursor++; continue; }
    if (words.length === 2) return null;
    const start = cursor;
    if (body[cursor] === '"') {
      cursor++;
      let closed = false;
      while (cursor < body.length) {
        const character = body[cursor++];
        if (character === "\\") cursor = Math.min(cursor + 1, body.length);
        else if (character === '"') { closed = true; break; }
      }
      if (!closed || (cursor < body.length && !/\s/u.test(body[cursor]))) return null;
    } else {
      while (cursor < body.length && !/\s/u.test(body[cursor])) cursor++;
    }
    words.push(body.slice(start, cursor));
  }
  return words.length === 2 ? sidePath(words[1]) : null;
}

export function summarizeTurnDiff(unifiedDiff: string): TurnDiffSummary {
  type File = { path: string; additions: number; deletions: number };
  const byPath = new Map<string, File>();
  let current: { path: string | null; additions: number; deletions: number; inHunk: boolean } | null = null;
  const flush = () => {
    if (current?.path == null) return;
    const file = byPath.get(current.path) ?? { path: current.path, additions: 0, deletions: 0 };
    file.additions += current.additions;
    file.deletions += current.deletions;
    byPath.set(file.path, file);
  };
  for (const line of unifiedDiff.split(/\r?\n/u)) {
    if (line.startsWith("diff --git ")) {
      flush();
      current = { path: destination(line), additions: 0, deletions: 0, inHunk: false };
      continue;
    }
    if (current === null) continue;
    if (line.startsWith("@@ ")) { current.inHunk = true; continue; }
    if (!current.inHunk) {
      if (line.startsWith("rename to ") || line.startsWith("copy to ")) {
        // Extended metadata contains the actual repository path, without a side prefix.
        current.path = decodePath(line.slice(line.indexOf(" to ") + 4));
        continue;
      }
      if (line.startsWith("--- ") || line.startsWith("+++ ")) {
        const wire = line.slice(4).split("\t", 1)[0];
        if (wire !== "/dev/null" && (line.startsWith("+++ ") || current.path === null)) current.path = sidePath(wire);
        continue;
      }
    }
    // Before the first hunk retain support for partial observations, but once in
    // a hunk +++/--- are ordinary added/removed code, not file headers.
    if (line.startsWith("+") && (current.inHunk || !line.startsWith("+++"))) current.additions++;
    if (line.startsWith("-") && (current.inHunk || !line.startsWith("---"))) current.deletions++;
  }
  flush();
  const files = [...byPath.values()];
  return {
    files,
    additions: files.reduce((total, file) => total + file.additions, 0),
    deletions: files.reduce((total, file) => total + file.deletions, 0),
  };
}

export function createTurnChangeSummary(
  turnId: string, status: TimelineStatus, unifiedDiff: string | null,
): TurnDiffTimelineBlock | null {
  if (unifiedDiff === null || !unifiedDiff.trim()) return null;
  return {
    type: "turn-diff", id: `${turnId}:turn-diff`, sourceItemIds: [], unifiedDiff,
    ...summarizeTurnDiff(unifiedDiff),
    status: status === "pending" || status === "streaming" ? "running" : status,
  };
}
