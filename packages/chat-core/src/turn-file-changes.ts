import type { TimelineSourceTurn } from "./projection";
import type { TurnDiffTimelineBlock } from "./timeline";
import { createTurnChangeSummary } from "./turn-diff";

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function text(value: unknown): string | null { return typeof value === "string" ? value : null; }

/** Protocol paths are lexical identities: recovery must not consult today's filesystem. */
function resolvePath(path: string, cwd: string | null): string {
  const windows = /^[a-z]:[\\/]/iu.test(path) || (cwd !== null && /^[a-z]:[\\/]/iu.test(cwd));
  const clean = (value: string) => windows ? value.replaceAll("\\", "/") : value;
  const value = clean(path);
  const absolute = value.startsWith("/") || /^[a-z]:\//iu.test(value);
  const joined = !absolute && cwd ? `${clean(cwd)}/${value}` : value;
  const prefix = joined.startsWith("//") ? "//" : joined.startsWith("/") ? "/" : "";
  const parts: string[] = [];
  for (const part of joined.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === ".." && parts.length > 0 && parts.at(-1) !== ".." && !/^[a-z]:$/iu.test(parts.at(-1)!)) parts.pop();
    else if (part !== ".." || (prefix === "" && !/^[a-z]:\//iu.test(joined))) parts.push(part);
  }
  return prefix + parts.join("/");
}
function quote(path: string): string { return /[\s"\\\x00-\x1f]/u.test(path) ? JSON.stringify(path) : path; }
function rawLines(diff: string): string[] {
  if (diff === "") return [];
  const lines = diff.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}
function patchBody(diff: string): string {
  // An update may contain only hunks, or its own Git/file headers. Keep hunk
  // content intact (including +++/--- code); the operation owns path identity.
  let inHunk = false;
  return diff.split("\n").filter(line => {
    if (line.startsWith("@@ ")) inHunk = true;
    return inHunk || !/^(?:diff --git |--- |\+\+\+ |rename from |rename to )/u.test(line);
  }).join("\n");
}

/** Recover the Turn resource from durable successful file operations. Live net
 * diffs take precedence at the caller; this is an operation history, not a claim
 * to reconstruct the net working-tree diff or a second persistent resource. */
export function recoverTurnChangeSummary(turn: TimelineSourceTurn): TurnDiffTimelineBlock | null {
  let cwd = text(record(turn.params).cwd);
  const chunks: string[] = [];
  const deferred = new Set<string>();
  const seen = new Set<string>();
  let incomplete = false;
  let statsIncomplete = false;
  const deferredStats = new Map<string, { additions: number; deletions: number }>();
  for (const item of turn.items) {
    const payload = record(item.payload);
    if (item.type === "commandExecution") { cwd = text(payload.cwd) ?? cwd; continue; }
    if (item.type !== "fileChange" || seen.has(item.id)) continue;
    seen.add(item.id);
    const status = text(payload.status);
    const active = turn.status === "streaming" || turn.status === "pending";
    if (status !== null && !["completed", "complete", "succeeded", "success", "applied"].includes(status)
      && !(active && ["inProgress", "running"].includes(status))) continue;
    if (!Array.isArray(payload.changes)) continue;
    for (const change of payload.changes) {
      const source = record(change), kindObject = record(source.kind);
      const path = text(source.path) ?? text(source.file);
      if (!path) continue;
      const kind = text(kindObject.type) ?? text(source.kind) ?? text(source.type);
      const oldPath = resolvePath(path, cwd);
      const move = text(kindObject.move_path) ?? text(kindObject.movePath) ?? text(source.move_path) ?? text(source.movePath);
      const newPath = move ? resolvePath(move, cwd) : oldPath;
      const diff = text(source.diff) ?? text(source.unifiedDiff) ?? text(source.unified_diff);
      const added = kind === "add" || kind === "added";
      const deleted = kind === "delete" || kind === "deleted";
      const header = [`diff --git ${quote(`a/${oldPath}`)} ${quote(`b/${newPath}`)}`,
        ...(move ? [`rename from ${quote(oldPath)}`, `rename to ${quote(newPath)}`] : []),
        `--- ${added ? "/dev/null" : quote(`a/${oldPath}`)}`,
        `+++ ${deleted ? "/dev/null" : quote(`b/${newPath}`)}`];
      if (diff === null) {
        // Presentation history deliberately omits large bodies. Keep every path,
        // but never pass metadata-only bytes off as a complete review or +0/-0.
        incomplete = true;
        const valid = source.diffStatsVersion === 1 && [source.additions, source.deletions].every(
          value => Number.isSafeInteger(value) && Number(value) >= 0);
        if (valid) {
          const prior = deferredStats.get(newPath) ?? { additions: 0, deletions: 0 };
          deferredStats.set(newPath, { additions: prior.additions + Number(source.additions), deletions: prior.deletions + Number(source.deletions) });
        } else statsIncomplete = true;
        if (payload.historyDetail != null) deferred.add(item.id);
      } else if (added || deleted) {
        const lines = rawLines(diff);
        header.push(added ? `@@ -0,0 +1,${lines.length} @@` : `@@ -1,${lines.length} +0,0 @@`,
          ...lines.map(line => `${added ? "+" : "-"}${line}`));
        if (diff !== "" && !diff.endsWith("\n")) header.push("\\ No newline at end of file");
      } else header.push(patchBody(diff));
      chunks.push(header.join("\n"));
    }
  }
  const block = createTurnChangeSummary(turn.id, turn.status, chunks.join("\n"));
  // Detail availability and statistics availability are independent. Versioned
  // producer counts survive presentation trimming without loading old bodies.
  const files = block?.files.map(file => {
    const extra = deferredStats.get(file.path);
    return extra ? { ...file, additions: file.additions + extra.additions, deletions: file.deletions + extra.deletions } : file;
  });
  return block === null ? null : {
    ...block,
    ...(files ? { files, additions: files.reduce((n, f) => n + f.additions, 0), deletions: files.reduce((n, f) => n + f.deletions, 0) } : {}),
    ...(incomplete ? { contentAvailable: false } : {}),
    ...(statsIncomplete ? { statsAvailable: false } : {}),
    ...(deferred.size > 0 ? { detailItemIds: [...deferred] } : {}),
  };
}
