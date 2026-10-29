import type { DatabaseSync } from "node:sqlite";
import { chmodSync, existsSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export function timestamp(): string { return new Date().toISOString().replaceAll(":", "-"); }

export function createBackup(database: DatabaseSync, path: string, target: number): string | undefined {
  if (path === ":memory:") return undefined;
  let time = Date.now();
  let destination = `${path}.pre-v${target}-${new Date(time).toISOString().replaceAll(":", "-")}.sqlite`;
  while (existsSync(destination)) destination = `${path}.pre-v${target}-${new Date(++time).toISOString().replaceAll(":", "-")}.sqlite`;
  // Reserve privately before SQLite opens it; VACUUM INTO accepts an empty file.
  writeFileSync(destination, "", { flag: "wx", mode: 0o600 });
  try {
    database.prepare("VACUUM INTO ?").run(destination);
    chmodSync(destination, 0o600);
  } catch (error) {
    // Only remove the incomplete file created by this attempt, never an older recovery point.
    unlinkSync(destination);
    throw error;
  }
  return destination;
}

export function pruneBackups(path: string, keep: number, currentBackupPath: string): void {
  if (path === ":memory:") return;
  const prefix = `${basename(path)}.pre-v`;
  const currentName = basename(currentBackupPath);
  const backups = readdirSync(dirname(path)).filter(name => name !== currentName && name.startsWith(prefix) && /\.pre-v\d+-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z\.sqlite$/.test(name))
    .sort((a, b) => b.slice(b.lastIndexOf(".pre-v")).replace(/^\.pre-v\d+-/, "").localeCompare(a.slice(a.lastIndexOf(".pre-v")).replace(/^\.pre-v\d+-/, "")));
  for (const name of backups.slice(keep - 1)) unlinkSync(join(dirname(path), name));
}
