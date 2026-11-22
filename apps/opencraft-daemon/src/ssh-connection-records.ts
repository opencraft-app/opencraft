import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open as openFile } from "node:fs/promises";
import { join } from "node:path";
import type { SshCodexServerBinding } from "./ssh-codex-connections.js";
import { validateSshConnection } from "./ssh-connection.js";

// SSH connection records, validation and bindings without storage IO. The
// network thread uses these; the SQLite store runs in its owner Worker.

export interface SshConnectionRecord {
  serverId: string;
  revision: number;
  displayName: string;
  hostname: string;
  port: number;
  username: string;
  enabled: boolean;
  hideFromNewChat?: boolean;
  workspaceBrowseRoots: string[];
  fingerprint: string;
}
export interface SshConnectionInput {
  displayName: string;
  hostname: string;
  port: number;
  username: string;
  enabled: boolean;
  hideFromNewChat?: boolean;
  workspaceBrowseRoots: string[];
  password?: string;
}
export class SshManagementError extends Error {
  constructor(
    readonly code: "invalid" | "conflict" | "missing" | "locked" | "unavailable" | "trust",
    readonly status = 400,
  ) {
    super(code);
    this.name = "SshManagementError";
  }
}

export function parseSshConnectionInput(value: unknown): SshConnectionInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SshManagementError("invalid");
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).some(
      (k) =>
        ![
          "displayName",
          "hostname",
          "port",
          "username",
          "enabled",
          "workspaceBrowseRoots",
          "password",
          "hideFromNewChat",
        ].includes(k),
    )
  )
    throw new SshManagementError("invalid");
  const { displayName, hostname, port, username, enabled, workspaceBrowseRoots, password, hideFromNewChat } = row;
  if (
    typeof displayName !== "string" ||
    !displayName.trim() ||
    displayName.length > 100 ||
    /[\r\n\0]/u.test(displayName) ||
    typeof hostname !== "string" ||
    hostname.length > 253 ||
    !/^[a-zA-Z0-9][a-zA-Z0-9.:-]*$/u.test(hostname) ||
    typeof username !== "string" ||
    !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,63}$/u.test(username) ||
    !Number.isInteger(port) ||
    Number(port) < 1 ||
    Number(port) > 65535 ||
    typeof enabled !== "boolean" ||
    !Array.isArray(workspaceBrowseRoots) ||
    workspaceBrowseRoots.length > 16 ||
    workspaceBrowseRoots.some(
      (p) => typeof p !== "string" || !p.startsWith("/") || p.length > 4096 || /[\r\n\0]/u.test(p),
    ) ||
    (hideFromNewChat !== undefined && typeof hideFromNewChat !== "boolean") ||
    (password !== undefined &&
      (typeof password !== "string" || !password || password.length > 4096 || /[\r\n\0]/u.test(password)))
  )
    throw new SshManagementError("invalid");
  return {
    displayName: displayName.trim(),
    hostname,
    port: Number(port),
    username,
    enabled,
    workspaceBrowseRoots: [...workspaceBrowseRoots] as string[],
    ...(hideFromNewChat === undefined ? {} : { hideFromNewChat: hideFromNewChat as boolean }),
    ...(password === undefined ? {} : { password: password as string }),
  };
}

/** readPrivateSshFile for a network thread: the same no-follow, owner-only checks, without blocking. */
export async function readPrivateSshFileAsync(path: string, maxBytes: number): Promise<Buffer> {
  const handle = await openFile(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (
      !info.isFile() ||
      info.size > maxBytes ||
      (process.platform !== "win32" && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()))
    )
      throw new Error("Private SSH storage permissions required");
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}
export function hostKeyFingerprint(hostKey: string): string {
  const fields = hostKey.trim().split(/\s+/u);
  if (fields.length !== 3 || fields[1] !== "ssh-ed25519" || !/^[a-zA-Z0-9+/]+={0,2}$/u.test(fields[2]!))
    throw new SshManagementError("trust");
  const decoded = Buffer.from(fields[2]!, "base64");
  if (
    decoded.length !== 51 ||
    decoded.toString("base64") !== fields[2] ||
    decoded.readUInt32BE(0) !== 11 ||
    decoded.subarray(4, 15).toString() !== "ssh-ed25519" ||
    decoded.readUInt32BE(15) !== 32
  )
    throw new SshManagementError("trust");
  return `SHA256:${createHash("sha256").update(decoded).digest("base64").replace(/=+$/u, "")}`;
}
export function knownHostsPath(directory: string, serverId: string): string {
  return join(directory, `${serverId.slice(4)}.known_hosts`);
}
/** A connection binding for an enabled record; the password is fetched when SSH asks for it. */
export function sshBinding(
  directory: string,
  config: SshConnectionRecord,
  resolvePassword: () => Promise<string>,
): SshCodexServerBinding {
  const connection = {
    hostname: config.hostname,
    port: config.port,
    username: config.username,
    knownHostsFile: knownHostsPath(directory, config.serverId),
    authentication: { kind: "password" as const, resolvePassword },
  };
  validateSshConnection(connection);
  return {
    descriptor: {
      serverId: config.serverId,
      displayName: config.displayName,
      workspaceBrowseRoots: config.workspaceBrowseRoots,
      ...(config.hideFromNewChat === undefined ? {} : { hideFromNewChat: config.hideFromNewChat }),
    },
    connection,
  };
}
