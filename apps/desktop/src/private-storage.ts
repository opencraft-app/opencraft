import { constants, existsSync, lstatSync, mkdirSync, chmodSync, openSync, fstatSync, readFileSync, writeFileSync, fsyncSync, closeSync, renameSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

/** Main-process persistence port. No Electron, OS keychain, or renderer access. */
export interface PrivateStorage {
  read(key: string): string | null;
  write(key: string, value: string): void;
  remove(key: string): void;
}

/** Plaintext protected by filesystem permissions, NOT an encrypted vault. */
export function createFilePrivateStorage(directory: string): PrivateStorage {
  const pathFor = (key: string) => {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(key)) throw new Error("Invalid private storage key");
    return join(directory, `${key}.json`);
  };
  const checkDirectory = (create: boolean) => {
    if (!existsSync(directory)) {
      if (!create) return false;
      mkdirSync(directory, { recursive: true, mode: 0o700 });
    }
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) throw new Error("Invalid private storage directory");
    chmodSync(directory, 0o700);
    return true;
  };
  return {
    read(key) {
      const path = pathFor(key);
      if (!checkDirectory(false) || !existsSync(path)) return null;
      const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.size > 64 * 1024 || (process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0))) throw new Error("Invalid private storage file");
        return readFileSync(fd, "utf8");
      } finally { closeSync(fd); }
    },
    write(key, value) {
      const path = pathFor(key);
      if (typeof value !== "string" || Buffer.byteLength(value) > 64 * 1024) throw new Error("Invalid private storage value");
      checkDirectory(true);
      const temporary = join(directory, `.${key}.${randomUUID()}.tmp`);
      try {
        const fd = openSync(temporary, "wx", 0o600);
        try { writeFileSync(fd, value, "utf8"); fsyncSync(fd); } finally { closeSync(fd); }
        renameSync(temporary, path);
      } finally { rmSync(temporary, { force: true }); }
    },
    remove(key) {
      const path = pathFor(key);
      if (checkDirectory(false)) rmSync(path, { force: true });
    },
  };
}
