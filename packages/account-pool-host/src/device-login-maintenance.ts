import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** A presentation annotation, never an alternative account outcome or receipt. */
export async function deviceLoginMaintenanceReason(dataDirectory: string, sessionId: string,
  result: { readonly status: "error"; readonly message: string }): Promise<"maintenance-interrupted" | undefined> {
  if (!UUID.test(sessionId) || result.message !== "Login cancelled.") return undefined;
  const directory = join(dataDirectory, "device-login-maintenance");
  try {
    const parent = await lstat(directory);
    if (!parent.isDirectory() || parent.uid !== process.getuid?.() || parent.mode & 0o077) return undefined;
    const file = await open(join(directory, `${sessionId}.json`), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.uid !== process.getuid?.() || info.mode & 0o077 || info.size > 32_768) return undefined;
      const annotation = record(JSON.parse(await file.readFile("utf8")));
      const source = record(annotation?.source), original = record(annotation?.originalResult);
      const digest = createHash("sha256").update(JSON.stringify({ message: result.message, status: result.status })).digest("hex");
      if (annotation?.version === 1 && annotation.kind === "device-login-maintenance"
        && annotation.sessionId === sessionId && annotation.cancelAttempted === true && annotation.terminal === true
        && annotation.disposition === "maintenance-interrupted" && annotation.resultSha256 === digest
        && original?.status === "error" && original.message === result.message && Object.keys(original).length === 2
        && typeof annotation.operationId === "string" && annotation.operationId.length > 0
        && source?.operationId === annotation.operationId && typeof source.owner === "string" && source.owner.length > 0
        && typeof source.fence === "string" && source.fence.length > 0 && Number.isSafeInteger(source.epoch)
        && (source.epoch as number) >= 0) return "maintenance-interrupted";
    } finally { await file.close(); }
  } catch {
    // Missing/corrupt display metadata never changes the original error or blocks
    // account admission. Credential and frozen-owner checks live elsewhere.
  }
  return undefined;
}
