import {
  existsSync,
  readFileSync,
  openSync,
  writeFileSync,
  fsyncSync,
  closeSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { digest } from "../../domain/values.mjs";

// Immutable local resources: replaying the same identity verifies the existing bytes.
export function publishOnce(path, body) {
  if (existsSync(path)) {
    if (readFileSync(path, "utf8") !== body) throw new Error("Resource identity already contains different bytes");
    return { path, hash: digest(body), reused: true };
  }
  const temporary = join(dirname(path), `.tmp-${randomUUID()}`);
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, body);
    fsyncSync(fd);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {}
    throw error;
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
  const directory = openSync(dirname(path), "r");
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
  return { path, hash: digest(body), reused: false };
}
