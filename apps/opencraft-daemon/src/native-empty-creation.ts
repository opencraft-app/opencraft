import { lstatSync, readFileSync } from "node:fs";

/** A native-written allocation receipt, never a synthesized conversation. */
export function nativeEmptyCreation(threadId: string, path: unknown): boolean {
  if (!threadId || typeof path !== "string" || !path) return false;
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.size > 1024 * 1024) return false;
    const lines = readFileSync(path, "utf8").split(/\r?\n/u).filter(line => line.trim());
    if (lines.length !== 1) return false;
    const row: unknown = JSON.parse(lines[0]!);
    if (!row || typeof row !== "object" || !("type" in row) || row.type !== "session_meta" || !("payload" in row)) return false;
    const payload = row.payload;
    return !!payload && typeof payload === "object" && "id" in payload && payload.id === threadId;
  } catch { return false; }
}
