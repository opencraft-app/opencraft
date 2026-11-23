export interface GitConnectionStatus {
  revision: number;
  configured: boolean;
  tokenConfigured: boolean;
  identity: null | { username: string; name: string; email: string; accountId?: string };
  sshAuth: null | { generation: string; publicKey: string; fingerprint: string };
  signing: null | {
    generation: string;
    publicKey: string;
    fingerprint: string;
    registration: "unregistered" | "pending" | "registered" | "manual_required";
    remoteKeyId?: number;
  };
}
export interface GitConnectionsSnapshot {
  scope: string;
  hosts: Record<string, GitConnectionStatus>;
}
/** How a compiled provider authenticates Git transport. `token` providers verify an
 * account token with the remote service; `ssh` providers keep a generated key pair
 * in the vault and the user registers its public key on the Git host. */
export type GitConnectionAuth = "token" | "ssh";
/** Non-secret provider metadata a server advertises beside its Git hosts. An SSH
 * provider's name is the deployment's product name for its host; it is shown as an
 * entity name, not translated copy. */
export type GitProviderDescriptor = { host: string; auth: "token" } | { host: string; auth: "ssh"; name: string };
export type GitConnectionInput<H extends string = string> = { host: H; revision: number } & (
  | { action: "save"; username: string; name: string; email: string; token?: string }
  | { action: "clear" | "register" | "delete-ssh" }
  | { action: "generate-ssh"; username?: string; name?: string; email?: string }
);
const GIT_HOST = /^[a-z0-9.-]{1,253}$/u;
/** Strict parse of advertised provider metadata. Unknown fields, duplicate hosts and
 * control characters reject the whole list instead of being partially trusted. */
export function parseGitProviders(value: unknown): GitProviderDescriptor[] {
  if (!Array.isArray(value) || value.length > 32) throw Error("invalid");
  const seen = new Set<string>();
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw Error("invalid");
    const row = item as Record<string, unknown>;
    if (typeof row.host !== "string" || !GIT_HOST.test(row.host) || seen.has(row.host)) throw Error("invalid");
    seen.add(row.host);
    if (row.auth === "token" && Object.keys(row).every((k) => k === "host" || k === "auth"))
      return { host: row.host, auth: "token" as const };
    if (
      row.auth === "ssh" &&
      Object.keys(row).every((k) => k === "host" || k === "auth" || k === "name") &&
      typeof row.name === "string" &&
      row.name.trim() &&
      row.name.length <= 64 &&
      !/[\x00-\x1f\x7f]/u.test(row.name)
    )
      return { host: row.host, auth: "ssh" as const, name: row.name };
    throw Error("invalid");
  });
}
/** Strict metadata projection: a provider response can never smuggle stored secret bytes into UI state. */
export function parseGitConnections(value: unknown, scope: string, hosts: readonly string[]): GitConnectionsSnapshot {
  const object = (v: unknown): Record<string, unknown> => {
    if (!v || typeof v !== "object" || Array.isArray(v)) throw Error("invalid");
    return v as Record<string, unknown>;
  };
  const allowed = (v: Record<string, unknown>, keys: string[]) => {
    if (Object.keys(v).some((k) => !keys.includes(k))) throw Error("invalid");
  };
  const text = (v: unknown, max = 1024): string => {
    if (typeof v !== "string" || v.length > max || /[\x00-\x1f\x7f]/u.test(v)) throw Error("invalid");
    return v;
  };
  const input = object(value);
  if (input.scope !== scope) throw Error("invalid");
  const records = object(input.hosts),
    output: Record<string, GitConnectionStatus> = {};
  for (const host of hosts) {
    const row = object(records[host]);
    allowed(row, ["revision", "configured", "tokenConfigured", "identity", "sshAuth", "signing"]);
    if (
      !Number.isSafeInteger(row.revision) ||
      Number(row.revision) < 0 ||
      typeof row.configured !== "boolean" ||
      typeof row.tokenConfigured !== "boolean"
    )
      throw Error("invalid");
    let identity: GitConnectionStatus["identity"] = null,
      sshAuth: GitConnectionStatus["sshAuth"] = null,
      signing: GitConnectionStatus["signing"] = null;
    if (row.identity !== null) {
      const i = object(row.identity);
      allowed(i, ["username", "name", "email", "accountId"]);
      identity = {
        username: text(i.username, 128),
        name: text(i.name, 256),
        email: text(i.email, 320),
        ...(i.accountId !== undefined ? { accountId: text(i.accountId, 128) } : {}),
      };
    }
    if (row.sshAuth !== null) {
      const s = object(row.sshAuth);
      allowed(s, ["generation", "publicKey", "fingerprint"]);
      sshAuth = {
        generation: text(s.generation, 128),
        publicKey: text(s.publicKey),
        fingerprint: text(s.fingerprint, 128),
      };
    }
    if (row.signing !== null) {
      const s = object(row.signing);
      allowed(s, ["generation", "publicKey", "fingerprint", "registration", "remoteKeyId"]);
      if (
        !["unregistered", "pending", "registered", "manual_required"].includes(String(s.registration)) ||
        (s.remoteKeyId !== undefined && !Number.isSafeInteger(s.remoteKeyId))
      )
        throw Error("invalid");
      signing = {
        generation: text(s.generation, 128),
        publicKey: text(s.publicKey),
        fingerprint: text(s.fingerprint, 128),
        registration: s.registration as NonNullable<GitConnectionStatus["signing"]>["registration"],
        ...(s.remoteKeyId !== undefined ? { remoteKeyId: Number(s.remoteKeyId) } : {}),
      };
    }
    output[host] = {
      revision: Number(row.revision),
      configured: row.configured,
      tokenConfigured: row.tokenConfigured,
      identity,
      sshAuth,
      signing,
    };
  }
  return { scope, hosts: output };
}
export function mergeGitConnections<T extends GitConnectionsSnapshot>(before: T | null, next: T): T {
  if (!before || before.scope !== next.scope) return next;
  return {
    ...next,
    hosts: Object.fromEntries(
      Object.entries(next.hosts).map(([host, row]) => [
        host,
        (before.hosts[host]?.revision ?? -1) > row.revision ? before.hosts[host]! : row,
      ]),
    ),
  };
}
