import { GitExecutionAuthority, type GitExecutionQuery } from "./git-execution-authority.js";
import {
  gitGrantAuthority,
  openGitGrant,
  type GitGrantScope,
} from "@opencraft/execution-environment/personal-git-protocol";
import { createDecipheriv, randomBytes } from "node:crypto";
import { readFile, lstat, chmod, rm, mkdir, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { createMemoryGitAuthenticator, createMemoryGitSigner } from "./git-identity-signer.js";
import type { GitVaultCredential } from "@opencraft/execution-environment/employee-git-vault-store";
import type { PersonalGitScope } from "@opencraft/execution-environment/personal-git";

const { directory, privateDirectory, hosts } = workerData as {
  directory: string;
  privateDirectory: string;
  hosts: string[];
};
const runtime = (await import("node:path")).dirname(privateDirectory);
await mkdir(runtime, { recursive: true, mode: 0o700 });
const knownHosts = join(runtime, "known_hosts");
try {
  await writeFile(knownHosts, "", { flag: "ax", mode: 0o600 });
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
}
const trust = await lstat(knownHosts),
  root = await lstat(runtime);
if (
  !trust.isFile() ||
  trust.uid !== process.getuid?.() ||
  trust.mode & 0o077 ||
  !root.isDirectory() ||
  root.uid !== process.getuid?.() ||
  root.mode & 0o077
)
  throw Error("personal_git_trust_unavailable");
await mkdir(privateDirectory, { mode: 0o700 });
type OpenEntry = {
  promise: Promise<Record<string, unknown>>;
  result?: Record<string, unknown>;
  waiters: number;
  delivered: boolean;
};
const opens = new Map<string, OpenEntry>();
let opening = 0;
type Session = {
  scope: GitGrantScope;
  authority: string;
  host: string;
  revision: number;
  credential: GitVaultCredential;
  expires: number;
  auth: Awaited<ReturnType<typeof createMemoryGitAuthenticator>> | null;
  signer: Awaited<ReturnType<typeof createMemoryGitSigner>> | null;
};
const sessions = new Map<string, Session>(),
  clients = new Set<Socket>();
let closed = false;
const vaultPath = join(directory, "employee-git-vault.sqlite"),
  keyPath = join(directory, "employee-git-vault.key");
for (const path of [vaultPath, keyPath]) {
  const info = await lstat(path);
  if (!info.isFile() || info.uid !== process.getuid?.() || info.mode & 0o077)
    throw Error("personal_git_vault_unavailable");
}
const key = await readFile(keyPath);
if (key.length !== 32) throw Error("personal_git_vault_unavailable");
const vault = new DatabaseSync(vaultPath, { readOnly: true });
vault.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=1000");
const executionAuthority = new GitExecutionAuthority(directory, workerData.accountMode ?? "principal");
const execution = (scope: GitExecutionQuery | undefined) => executionAuthority.resolve(scope);
function authority(
  scope: (GitExecutionQuery & Partial<Pick<GitGrantScope, "account" | "leaseGeneration" | "actorGeneration" | "membershipRevision">>) | undefined,
): string | null {
  if (!scope?.account || !scope.threadId || !scope.inputId || !scope.executionId) return null;
  const current = execution(scope);
  return current?.account === scope.account &&
    current.generation === scope.leaseGeneration &&
    (workerData.accountMode !== "actor" ||
      (current.actorGeneration === scope.actorGeneration && current.membershipRevision === scope.membershipRevision))
    ? current.authority
    : null;
}
function credential(account: string, host: string): { revision: number; credential: GitVaultCredential | null } {
  const row = vault
    .prepare("SELECT revision,credential FROM employee_git_credentials WHERE account=? AND host=?")
    .get(account, host);
  if (!row?.credential) return { revision: Number(row?.revision ?? 0), credential: null };
  const data = Buffer.from(row.credential as Uint8Array),
    decipher = createDecipheriv("aes-256-gcm", key, data.subarray(0, 12));
  decipher.setAAD(Buffer.from(JSON.stringify(["employee-git-vault", 1, account, host, "credential"])));
  decipher.setAuthTag(data.subarray(-16));
  const clear = Buffer.concat([decipher.update(data.subarray(12, -16)), decipher.final()]);
  try {
    return { revision: Number(row.revision), credential: JSON.parse(clear.toString()) };
  } finally {
    clear.fill(0);
  }
}
async function remove(id: string) {
  const session = sessions.get(id);
  if (!session) return;
  sessions.delete(id);
  for (const [key, e] of opens) if (e.result?.sessionId === id) opens.delete(key);
  await Promise.all([session.auth?.close(), session.signer?.close()]);
}
let nextAuthorityRead = 0;
const authorityReads = new Map<
  number,
  { resolve(v: boolean): void; reject(e: Error): void; timer: ReturnType<typeof setTimeout> }
>();
async function liveAuthority(scope: GitGrantScope): Promise<boolean> {
  if (workerData.accountMode !== "actor") return true;
  if (closed || authorityReads.size >= 32) throw Error("git_live_authority_unavailable");
  const id = ++nextAuthorityRead;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      authorityReads.delete(id);
      reject(Error("git_live_authority_unavailable"));
    }, 2000);
    authorityReads.set(id, { resolve, reject, timer });
    parentPort!.postMessage({ type: "authorize-execution", id, scope });
  });
}
async function authorized(session: Session): Promise<boolean> {
  const scope = session.scope;
  const before = authority(scope ?? undefined);
  if (closed || session.expires <= Date.now() || !before || before !== session.authority) return false;
  if (!(await liveAuthority(scope))) return false;
  return (
    !closed &&
    session.expires > Date.now() &&
    authority(scope) === before &&
    credential(scope.account, session.host).revision === session.revision
  );
}
async function request(input: unknown): Promise<Record<string, unknown>> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { status: "unavailable" };
  const r = input as Record<string, unknown>;
  if (r.op === "probe")
    return {
      status:
        r.protocol === 2 && r.authority === gitGrantAuthority(key, workerData.accountMode ?? "principal")
          ? "ready"
          : "denied",
      protocol: 2,
      authority: gitGrantAuthority(key, workerData.accountMode ?? "principal"),
    };
  if (r.op === "open") {
    if (!workerData.serveExecution) return { status: "denied", reason: "metadata-only-owner" };
    if (
      typeof r.capability !== "string" ||
      typeof r.host !== "string" ||
      !hosts.includes(r.host) ||
      typeof r.threadId !== "string"
    )
      return { status: "denied" };
    const scope = openGitGrant(key, r.capability);
    const currentAuthority = authority(scope ?? undefined);
    if (!scope || scope.threadId !== r.threadId || !currentAuthority) return { status: "expired" };
    if (!(await liveAuthority(scope)) || authority(scope) !== currentAuthority) return { status: "expired" };
    const record = credential(scope.account!, r.host),
      c = record.credential;
    if (!c) return { status: "unbound" };
    const session: Session = {
      scope: scope!,
      authority: currentAuthority!,
      host: r.host,
      revision: record.revision,
      credential: c,
      expires: Date.now() + 300_000,
      auth: null,
      signer: null,
    };
    try {
      const check = () => authorized(session);
      if (c.sshAuth && ["push", "fetch", "pull", "ls-remote", "clone"].includes(String(r.operation)))
        session.auth = await createMemoryGitAuthenticator(c.sshAuth, privateDirectory, 300_000, check);
      if (c.signing) session.signer = await createMemoryGitSigner(c.signing, privateDirectory, 300_000, check);
      if (closed) {
        await session.auth?.close();
        await session.signer?.close();
        return { status: "unavailable", reason: "broker-closed" };
      }
      const id = randomBytes(32).toString("base64url");
      sessions.set(id, session);
      return {
        status: "configured",
        sessionId: id,
        identity: c.identity,
        ...(session.auth ? { sshAuth: { socket: session.auth.path, publicKey: c.sshAuth!.publicKey } } : {}),
        ...(session.signer ? { signing: { socket: session.signer.path, publicKey: c.signing!.publicKey } } : {}),
      };
    } catch {
      await session.auth?.close();
      await session.signer?.close();
      return { status: "unavailable", reason: "agent-unavailable" };
    }
  }
  if (typeof r.sessionId !== "string") return { status: "denied" };
  const session = sessions.get(r.sessionId);
  if (!session) return { status: "expired" };
  if (r.op === "close") {
    await remove(r.sessionId);
    return { status: "closed" };
  }
  if (r.op !== "credential" || !(await authorized(session))) return { status: "expired" };
  if (session.credential.sshAuth || !session.credential.token || r.protocol !== "https" || r.host !== session.host)
    return { status: "denied" };
  return { status: "configured", username: session.credential.identity.username, password: session.credential.token };
}
const diagnosticAt = new Map<string, number>();
function unavailable(reason: string, requestId?: unknown): Record<string, unknown> {
  if (Date.now() - (diagnosticAt.get(reason) ?? 0) > 10_000) {
    diagnosticAt.set(reason, Date.now());
    console.warn(
      JSON.stringify({
        component: "personal-git",
        reason,
        ...(typeof requestId === "string" && /^[a-zA-Z0-9-]{1,80}$/u.test(requestId) ? { requestId } : {}),
      }),
    );
  }
  return { status: "unavailable", reason };
}
const server = createServer((socket) => {
  clients.add(socket);
  socket.on("error", () => socket.destroy());
  socket.on("close", () => clients.delete(socket));
  socket.setTimeout(10_000, () => socket.destroy());
  socket.setEncoding("utf8");
  let buffer = "",
    handled = false;
  socket.on("data", (chunk) => {
    if (handled) return;
    buffer += chunk;
    if (buffer.length > 32_768) {
      socket.destroy();
      return;
    }
    const at = buffer.indexOf("\n");
    if (at < 0) return;
    handled = true;
    let input: Record<string, unknown>;
    try {
      input = JSON.parse(buffer.slice(0, at));
    } catch {
      socket.end(JSON.stringify({ status: "denied", reason: "invalid-request" }) + "\n");
      return;
    }
    let entry: OpenEntry | undefined, cacheKey: string | undefined;
    if (input?.op === "open") {
      if (
        input.requestId !== undefined &&
        (typeof input.requestId !== "string" || !/^[a-zA-Z0-9-]{1,80}$/u.test(input.requestId))
      ) {
        socket.end(JSON.stringify({ status: "denied", reason: "invalid-request" }) + "\n");
        return;
      }
      cacheKey = JSON.stringify([
        input.capability,
        input.threadId,
        input.host,
        input.operation,
        input.requestId ?? randomBytes(16).toString("hex"),
      ]);
      entry = opens.get(cacheKey);
      if (!entry) {
        if (sessions.size + opening >= 128) {
          socket.end(JSON.stringify(unavailable("session-capacity", input.requestId)) + "\n");
          return;
        }
        opening++;
        entry = {
          promise: Promise.resolve()
            .then(() => request(input))
            .catch(() => unavailable("authority-store-unavailable", input.requestId))
            .finally(() => {
              opening--;
            }),
          waiters: 0,
          delivered: false,
        };
        opens.set(cacheKey, entry);
      }
      entry.waiters++;
    }
    const active = entry;
    void (
      active?.promise ??
      Promise.resolve()
        .then(() => request(input))
        .catch(() => unavailable("authority-store-unavailable", input.requestId))
    ).then(async (value) => {
      if (value.status === "configured" && typeof value.sessionId === "string") {
        const current = sessions.get(value.sessionId);
        let valid = false,
          unavailableStore = false;
        try {
          valid = !!current && (await authorized(current));
        } catch {
          unavailableStore = true;
        }
        if (unavailableStore) value = unavailable("authority-store-unavailable", input.requestId);
        else if (!valid) {
          await remove(value.sessionId);
          value = { status: "expired", reason: "execution-revoked" };
        }
      }
      if (active) active.result = value;
      let retired = false;
      const retire = async () => {
        if (retired) return;
        retired = true;
        if (!active) return;
        active.waiters--;
        if (!active.waiters && !active.delivered) {
          if (typeof value.sessionId === "string") await remove(value.sessionId);
          if (cacheKey) opens.delete(cacheKey);
        } else if (value.status !== "configured" && cacheKey) opens.delete(cacheKey);
      };
      if (socket.destroyed) {
        await retire();
        return;
      }
      socket.once("close", () => {
        void retire();
      });
      socket.end(JSON.stringify(value) + "\n", () => {
        if (active && !socket.destroyed) active.delivered = true;
        void retire();
      });
    });
  });
});
server.on("error", () => {
  void close();
});
async function close() {
  if (closed) return;
  closed = true;
  clearInterval(timer);
  for (const read of authorityReads.values()) {
    clearTimeout(read.timer);
    read.reject(Error("git_live_authority_unavailable"));
  }
  authorityReads.clear();
  for (const socket of clients) socket.destroy();
  await Promise.all([...sessions.keys()].map(remove));
  await new Promise<void>((resolve) => server.close(() => resolve()));
  executionAuthority.close();
  vault.close();
  key.fill(0);
  await rm(privateDirectory, { recursive: true, force: true });
  parentPort?.close();
}
const timer = setInterval(() => {
  for (const [id, session] of sessions) {
    if (session.expires <= Date.now()) {
      void remove(id);
      continue;
    }
    try {
      if (authority(session.scope) !== session.authority) void remove(id);
    } catch {
      unavailable("authority-store-unavailable");
    }
  }
}, 1000);
timer.unref();
parentPort!.on("message", (message) => {
  if (message?.type === "execution-authorized") {
    const read = authorityReads.get(message.id);
    if (!read) return;
    authorityReads.delete(message.id);
    clearTimeout(read.timer);
    if (message.error) read.reject(Error("git_live_authority_unavailable"));
    else read.resolve(message.current === true);
    return;
  }
  if (message.type === "close") {
    void close();
    return;
  }
  if (message.type === "status") {
    try {
      const current = execution(message.scope);
      if (!current) throw Error("unavailable");
      parentPort!.postMessage({
        id: message.id,
        result: {
          identity: current.principal,
          hosts: hosts.map((host) => {
            const row = credential(current.account, host);
            return {
              host,
              revision: row.revision,
              binding: row.credential ? "configured" : "unbound",
              sshConfigured: !!row.credential?.sshAuth,
              username: row.credential?.identity?.username ?? null,
            };
          }),
          transport: "platform-managed-git",
          protocol: 2,
          bindingStateOnly: true,
          commandProbe: "not-run",
          mcpCredentialsIndependent: true,
        },
      });
    } catch {
      parentPort!.postMessage({ id: message.id, error: "personal_git_execution_unavailable" });
    }
    return;
  }
  // Grants are sealed attestations; preparing another scope cannot revoke a live lease.
});
await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(join(privateDirectory, "broker.sock"), () => resolve());
});
await chmod(join(privateDirectory, "broker.sock"), 0o600);
if (workerData.serveExecution)
  await writeFile(
    join(privateDirectory, "ready.json"),
    JSON.stringify({
      protocol: 2,
      authority: gitGrantAuthority(key, workerData.accountMode ?? "principal"),
      socket: join(privateDirectory, "broker.sock"),
    }),
    { mode: 0o600, flag: "wx" },
  );
parentPort!.postMessage({
  type: "ready",
  protocol: 2,
  authority: gitGrantAuthority(key, workerData.accountMode ?? "principal"),
});
