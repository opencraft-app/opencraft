import type { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { openManagedDatabase, type DatabaseOutcome } from "@opencraft/sqlite-node";

import {
  UI_PREFERENCE_KEYS,
  type CompareAndSetPreferenceResult,
  type StoredUiPreference,
  type UiPreferenceKey,
} from "@opencraft/ui-preferences";

const BASELINE = `
CREATE TABLE ui_preferences (
  key TEXT PRIMARY KEY NOT NULL,
  value_json TEXT NOT NULL,
  revision INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT
`.trim();

const ALLOWED_KEYS = new Set<string>(UI_PREFERENCE_KEYS);

function preferenceKey(value: unknown): UiPreferenceKey {
  if (typeof value !== "string" || !ALLOWED_KEYS.has(value)) {
    throw new TypeError("Invalid UI preference key");
  }
  return value as UiPreferenceKey;
}

function revisionValue(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new TypeError("Invalid UI preference revision");
  }
  return Number(value);
}

function jsonValue(value: unknown): string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 64 * 1024) {
    throw new TypeError("Invalid UI preference value");
  }
  JSON.parse(value);
  return value;
}

/** Installation authority for Electron; Renderer never supplies a database path. */
export class DesktopUiPreferenceStore {
  readonly #database: DatabaseSync;
  readonly outcome: DatabaseOutcome;

  constructor(path: string) {
    const resolvedPath = path === ":memory:" ? ":memory:" : resolve(path);
    const managed = openManagedDatabase({
      path: resolvedPath,
      migrations: [{ version: 1, name: "ui-preferences", sql: BASELINE }],
    });
    this.#database = managed.database;
    this.outcome = managed.outcome;
    this.#database.exec("PRAGMA synchronous = NORMAL;");
  }

  load(rawKey: unknown): StoredUiPreference | null {
    const key = preferenceKey(rawKey);
    const row = this.#database.prepare(
      "SELECT key, value_json, revision, updated_at FROM ui_preferences WHERE key = ?",
    ).get(key) as { key: string; value_json: string; revision: number; updated_at: number } | undefined;
    return row === undefined ? null : Object.freeze({
      key: preferenceKey(row.key),
      valueJson: row.value_json,
      revision: row.revision,
      updatedAt: row.updated_at,
    });
  }

  compareAndSet(rawKey: unknown, rawExpectedRevision: unknown, rawValueJson: unknown): CompareAndSetPreferenceResult {
    const key = preferenceKey(rawKey);
    const expectedRevision = revisionValue(rawExpectedRevision);
    const valueJson = jsonValue(rawValueJson);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const current = this.#database.prepare(
        "SELECT revision FROM ui_preferences WHERE key = ?",
      ).get(key) as { revision: number } | undefined;
      const revision = current?.revision ?? 0;
      if (revision !== expectedRevision) {
        this.#database.exec("ROLLBACK");
        return { outcome: "conflict", revision };
      }
      const record = Object.freeze({
        key,
        valueJson,
        revision: revision + 1,
        updatedAt: Date.now(),
      });
      this.#database.prepare(`
        INSERT INTO ui_preferences (key, value_json, revision, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value_json = excluded.value_json,
          revision = excluded.revision,
          updated_at = excluded.updated_at
      `).run(key, valueJson, record.revision, record.updatedAt);
      this.#database.exec("COMMIT");
      return { outcome: "updated", record };
    } catch (error) {
      try { this.#database.exec("ROLLBACK"); } catch { /* Preserve the original failure. */ }
      throw error;
    }
  }

  close(): void {
    this.#database.close();
  }
}
