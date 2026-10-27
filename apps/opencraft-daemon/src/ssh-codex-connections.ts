import { readFile, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { CodexEngineAdapter } from "./codex-engine-adapter.js";
import { SshCodexTransport, type SshCodexTransportOptions } from "./ssh-codex-transport.js";
import type { SshServerDescriptor } from "@opencraft/app-host-protocol";
import { createSshAttachmentOptions } from "./ssh-attachment-options.js";

export interface SshCodexServerBinding {
  readonly descriptor: SshServerDescriptor;
  readonly connection: SshCodexTransportOptions;
}

async function privateFile(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error("SSH configuration and credential paths must be absolute");
  const info = await stat(path);
  if (!info.isFile() || info.size > 64 * 1024 || (process.platform !== "win32" && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()))) throw new Error("SSH configuration must be a private owner-only file");
  return readFile(path, "utf8");
}

/** Private backend config references credentials; no passwords in config/DTOs. */
export async function readSshCodexServerBindings(path: string): Promise<readonly SshCodexServerBinding[]> {
  const json = await privateFile(path);
  let value: unknown;
  try { value = JSON.parse(json); }
  catch { throw new Error("Invalid SSH Server configuration"); }
  if (!Array.isArray(value) || value.length > 32) throw new Error("Invalid SSH Server configuration");
  const ids = new Set<string>();
  return value.map(entry => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Invalid SSH Server entry");
    const allowed = new Set(["serverId", "displayName", "workspaceBrowseRoots", "hostname", "port", "username", "knownHostsFile", "authentication", "codexExecutable", "codexHome", "socketPath"]);
    if (Object.keys(entry).some(key => !allowed.has(key))) throw new Error("Unknown SSH Server configuration field");
    const { serverId, displayName, workspaceBrowseRoots = [], authentication, ...rest } = entry;
    if (typeof serverId !== "string" || !/^ssh:[a-zA-Z0-9._-]{1,80}$/u.test(serverId) || ids.has(serverId)) throw new Error("Invalid or duplicate SSH Server identity");
    ids.add(serverId);
    if (typeof displayName !== "string" || !displayName.trim() || displayName.length > 100 || /[\r\n\0]/u.test(displayName)) throw new Error("Invalid SSH Server display name");
    if (!Array.isArray(workspaceBrowseRoots) || workspaceBrowseRoots.length > 16 || workspaceBrowseRoots.some(root => typeof root !== "string" || !isAbsolute(root))) throw new Error("Invalid remote workspace roots");
    if (!authentication || typeof authentication !== "object" || Array.isArray(authentication)) throw new Error("Invalid SSH authentication configuration");
    let auth: SshCodexTransportOptions["authentication"];
    if (authentication.kind === "agent" && Object.keys(authentication).length === 1) auth = { kind: "agent" };
    else if (authentication.kind === "key" && typeof authentication.identityFile === "string" && Object.keys(authentication).length === 2) auth = { kind: "key", identityFile: authentication.identityFile };
    else if (authentication.kind === "password-file" && typeof authentication.path === "string" && isAbsolute(authentication.path) && Object.keys(authentication).length === 2) {
      const passwordPath = authentication.path;
      auth = { kind: "password", resolvePassword: async () => {
        const secret = (await privateFile(passwordPath)).replace(/\r?\n$/u, "");
        if (!secret || /[\r\n\0]/u.test(secret)) throw new Error("Invalid SSH credential file");
        return secret;
      } };
    } else throw new Error("Invalid SSH authentication configuration");
    if (typeof rest.hostname !== "string" || typeof rest.port !== "number" || typeof rest.username !== "string" || typeof rest.knownHostsFile !== "string"
      || (rest.codexExecutable !== undefined && typeof rest.codexExecutable !== "string") || (rest.codexHome !== undefined && typeof rest.codexHome !== "string") || (rest.socketPath !== undefined && typeof rest.socketPath !== "string")) throw new Error("Invalid SSH connection configuration");
    const connection: SshCodexTransportOptions = { hostname: rest.hostname, port: rest.port, username: rest.username, knownHostsFile: rest.knownHostsFile, authentication: auth,
      ...(rest.codexExecutable === undefined ? {} : { codexExecutable: rest.codexExecutable }), ...(rest.codexHome === undefined ? {} : { codexHome: rest.codexHome }), ...(rest.socketPath === undefined ? {} : { socketPath: rest.socketPath }) };
    new SshCodexTransport(connection); // Validate without network or credential reads.
    return { descriptor: { serverId, displayName, workspaceBrowseRoots }, connection };
  });
}

export function createSshCodexEngineAdapter(binding: SshCodexServerBinding, stateDirectory?: string, createThreadMetadata?: import("./codex-engine-adapter").RemoteCodexEngineOptions["createThreadMetadata"], onStorageOpened?: import("./codex-engine-adapter").RemoteCodexEngineOptions["onStorageOpened"]): CodexEngineAdapter {
  const connection = binding.connection;
  return new CodexEngineAdapter({ kind: "remote", transport: new SshCodexTransport(connection),
    ...createSshAttachmentOptions(binding, stateDirectory), createThreadMetadata, onStorageOpened,
  });
}
