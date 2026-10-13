export type SqliteLifecycleErrorKind = "busy" | "history-mismatch" | "newer-schema" | "unsupported-legacy" | "io" | "migration-failed";

export class SqliteLifecycleError extends Error {
  constructor(readonly kind: SqliteLifecycleErrorKind, message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "SqliteLifecycleError";
  }
}

export function classifyError(error: unknown): SqliteLifecycleError {
  if (error instanceof SqliteLifecycleError) return error;
  const details = error as { errcode?: number; code?: string } | null;
  const primaryCode = typeof details?.errcode === "number" ? details.errcode & 0xff : undefined;
  const kind = primaryCode === 5 || primaryCode === 6 ? "busy"
    : primaryCode === 1 || primaryCode === 19 ? "migration-failed" : "io";
  return new SqliteLifecycleError(kind, `SQLite lifecycle failed (${kind})`, error);
}
