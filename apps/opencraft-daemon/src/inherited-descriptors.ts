import { closeSync, readdirSync, readFileSync, readlinkSync } from "node:fs";

const O_CLOEXEC = 0o2000000;

/** Inodes of listening TCP sockets on this host; none is the daemon's own before it listens. */
function tcpListeners(proc: string): Set<string> {
  const inodes = new Set<string>();
  for (const table of [`${proc}/net/tcp`, `${proc}/net/tcp6`]) {
    let lines: string[];
    try {
      lines = readFileSync(table, "utf8").split("\n").slice(1);
    } catch {
      continue;
    }
    for (const line of lines) {
      const fields = line.trim().split(/\s+/u);
      if (fields[3] === "0A" && fields[9]) inodes.add(fields[9]);
    }
  }
  return inodes;
}

/**
 * Close descriptors this process inherited by accident. Electron's browser
 * process hands every child its non-close-on-exec descriptors, the DevTools
 * listening socket among them; the daemon and the long-lived owners it starts
 * (terminal PTY owner, Codex bridge stack) would otherwise keep that port bound
 * after the app quits. Node creates its own descriptors close-on-exec, so on
 * Linux any descriptor above stdio without the flag came from the parent.
 * Node itself marks some inherited descriptors close-on-exec at startup, so a
 * listening TCP socket is closed whatever its flags: called before the daemon
 * listens on anything, any listener it holds is inherited.
 * macOS spawns with POSIX_SPAWN_CLOEXEC_DEFAULT and inherits nothing extra.
 * Returns the descriptors it closed.
 */
export function closeInheritedDescriptors(platform: NodeJS.Platform = process.platform, proc = "/proc"): number[] {
  if (platform !== "linux") return [];
  let entries: string[];
  try {
    entries = readdirSync(`${proc}/self/fdinfo`);
  } catch {
    return [];
  }
  const closed: number[] = [];
  let listeners: Set<string> | undefined;
  for (const entry of entries) {
    const fd = Number(entry);
    if (!Number.isSafeInteger(fd) || fd <= 2) continue;
    let flags: number;
    try {
      const match = /^flags:\s*([0-7]+)$/mu.exec(readFileSync(`${proc}/self/fdinfo/${fd}`, "utf8"));
      if (!match) continue;
      flags = Number.parseInt(match[1]!, 8);
    } catch {
      continue; // Gone already, or the directory listing's own descriptor.
    }
    if (flags & O_CLOEXEC) {
      let target: string;
      try {
        target = readlinkSync(`${proc}/self/fd/${fd}`);
      } catch {
        continue;
      }
      const socket = /^socket:\[(\d+)\]$/u.exec(target)?.[1];
      if (!socket || !(listeners ??= tcpListeners(proc)).has(socket)) continue;
    }
    try {
      closeSync(fd);
      closed.push(fd);
    } catch {
      /* already closed */
    }
  }
  return closed;
}
