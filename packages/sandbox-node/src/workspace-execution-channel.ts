import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, request, type IncomingMessage, type ServerResponse } from "node:http";
import { chmod, lstat, realpath, unlink } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import type { Socket } from "node:net";

export const workspaceGrantField = "__opencraftWorkspaceGrant";
export type WorkspaceExecutionMethod = "thread/start" | "thread/resume" | "turn/start";
export type WorkspaceExecutionSelection =
  | { kind: "local" }
  | {
      kind: "bound";
      workspaceId: string;
      generation: number;
      environmentId: string;
      cwd: string;
      execServerUrl: string;
    };
export const isWorkspaceExecutionMethod = (value: unknown): value is WorkspaceExecutionMethod =>
  value === "thread/start" || value === "thread/resume" || value === "turn/start";
const unavailable = () => new Error("Workspace execution authority unavailable");
const limit = 64 * 1024;
function fingerprint(method: WorkspaceExecutionMethod, params: Record<string, unknown>): string {
  // These six fields belong to the existing callback relay, which validates and
  // removes them before invoking the Native execution policy. They are not
  // Native execution params. All other caller fields remain bound verbatim.
  const {
    __opencraftDeferPublication: _defer,
    __opencraftOrchestrationOperation: _operation,
    __opencraftOrchestrationFingerprint: _fingerprint,
    __opencraftOrchestrationIncarnation: _incarnation,
    __opencraftOrchestrationSourceThreadId: _source,
    __opencraftDelegationId: _delegation,
    ...nativeParams
  } = params;
  // Match the JSON wire representation independently of object key order.
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
      );
    return value;
  };
  return createHash("sha256")
    .update(JSON.stringify(canonical([method, JSON.parse(JSON.stringify(nativeParams))])))
    .digest("hex");
}
export function validateWorkspaceExecutionSelection(input: unknown): WorkspaceExecutionSelection {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw unavailable();
  const value = input as Record<string, unknown>;
  if (value.kind === "local" && Object.keys(value).length === 1) return { kind: "local" };
  if (
    value.kind !== "bound" ||
    Object.keys(value).length !== 6 ||
    typeof value.workspaceId !== "string" ||
    !/^ws-[a-zA-Z0-9_-]{1,160}$/.test(value.workspaceId) ||
    value.environmentId !== `workspace-${value.workspaceId}` ||
    !Number.isSafeInteger(value.generation) ||
    (value.generation as number) < 1 ||
    typeof value.cwd !== "string" ||
    !value.cwd.startsWith("/workspace") ||
    (value.cwd !== "/workspace" && !value.cwd.startsWith("/workspace/")) ||
    /[\\\x00-\x1f]/u.test(value.cwd) ||
    value.cwd.split("/").some((p) => p === "." || p === "..") ||
    typeof value.execServerUrl !== "string" ||
    !/^ws:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/[a-f0-9]{64}$/.test(value.execServerUrl) ||
    Number(value.execServerUrl.split(":")[2]?.split("/")[0]) > 65535
  )
    throw unavailable();
  return {
    kind: "bound",
    workspaceId: value.workspaceId,
    generation: value.generation as number,
    environmentId: value.environmentId,
    cwd: value.cwd,
    execServerUrl: value.execServerUrl,
  };
}

/** Private Gateway-owned one-shot admission. Tickets are never renderer params,
 * durable thread metadata or logs. Native generations consume through one owner,
 * so replay across generations is also rejected. resolve must only reauthorize
 * an existing prepared lease; allocation belongs before minting, not this RPC. */
export async function createWorkspaceExecutionAuthority(options: {
  socketPath: string;
  token: string;
  maxPending?: number;
  lifetimeMs?: number;
}) {
  const maximum = options.maxPending ?? 256,
    lifetime = options.lifetimeMs ?? 60_000;
  if (
    !isAbsolute(options.socketPath) ||
    options.token.length < 32 ||
    !Number.isSafeInteger(maximum) ||
    maximum < 1 ||
    maximum > 4096 ||
    !Number.isSafeInteger(lifetime) ||
    lifetime < 1 ||
    lifetime > 60_000
  )
    throw unavailable();
  const parent = dirname(options.socketPath),
    metadata = await lstat(parent);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.mode & 0o077 ||
    (await realpath(parent)) !== parent ||
    (process.getuid && metadata.uid !== process.getuid())
  )
    throw unavailable();
  const expected = Buffer.from(`Bearer ${options.token}`),
    sockets = new Set<Socket>();
  const grants = new Map<string, { digest: string; until: number; resolve(): Promise<WorkspaceExecutionSelection> }>();
  let closed = false,
    resolving = 0;
  const prune = () => {
    const now = performance.now();
    for (const [key, grant] of grants) if (grant.until <= now) grants.delete(key);
  };
  const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const reject = () => {
      if (!res.destroyed) {
        res.writeHead(503);
        res.end('{"error":"Workspace execution authority unavailable"}');
      }
    };
    try {
      const supplied = Buffer.from(req.headers.authorization ?? "");
      if (
        closed ||
        req.method !== "POST" ||
        req.url !== "/consume" ||
        supplied.length !== expected.length ||
        !timingSafeEqual(supplied, expected)
      ) {
        req.resume();
        reject();
        return;
      }
      let bytes = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > limit) throw unavailable();
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (
        typeof body.ticket !== "string" ||
        !/^[a-f0-9]{64}$/.test(body.ticket) ||
        typeof body.digest !== "string" ||
        !/^[a-f0-9]{64}$/.test(body.digest)
      )
        throw unavailable();
      prune();
      const grant = grants.get(body.ticket);
      // Retire before awaiting: no duplicate receiver or retry can execute it.
      grants.delete(body.ticket);
      if (!grant || grant.digest !== body.digest || resolving >= maximum) throw unavailable();
      resolving++;
      try {
        const selection = validateWorkspaceExecutionSelection(await grant.resolve());
        if (closed || res.destroyed || grant.until <= performance.now()) throw unavailable();
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(selection));
      } finally {
        resolving--;
      }
    } catch {
      reject();
    }
  };
  const server = createServer((req, res) => {
    void handleRequest(req, res).catch(() => res.destroy());
  });
  server.maxConnections = maximum * 2 + 16;
  server.maxRequestsPerSocket = 1;
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.setTimeout(10_000, () => socket.destroy());
    socket.once("close", () => sockets.delete(socket));
  });
  // Never remove an existing socket: it may still belong to a live Gateway.
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  try {
    await chmod(options.socketPath, 0o600);
  } catch (error) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await unlink(options.socketPath).catch(() => {});
    throw error;
  }
  const inode = (await lstat(options.socketPath)).ino;
  let closing: Promise<void> | undefined;
  return {
    mint(
      method: WorkspaceExecutionMethod,
      params: Record<string, unknown>,
      resolve: () => Promise<WorkspaceExecutionSelection>,
    ) {
      if (!isWorkspaceExecutionMethod(method) || Object.hasOwn(params, workspaceGrantField)) throw unavailable();
      prune();
      if (closed || grants.size + resolving >= maximum) throw unavailable();
      const ticket = randomBytes(32).toString("hex");
      grants.set(ticket, { digest: fingerprint(method, params), until: performance.now() + lifetime, resolve });
      return {
        ticket,
        cancel() {
          grants.delete(ticket);
        },
      };
    },
    close() {
      return (closing ??= (async () => {
        closed = true;
        grants.clear();
        sockets.forEach((socket) => socket.destroy());
        await new Promise<void>((resolve) => server.close(() => resolve()));
        try {
          if ((await lstat(options.socketPath)).ino === inode) await unlink(options.socketPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      })());
    },
  };
}

/** Single request, no retry. A lost response consumes admission and must not
 * create another Native turn. Only the Gateway may mint another authorized try. */
export async function consumeWorkspaceExecutionGrant(
  options: { socketPath: string; token: string },
  ticket: unknown,
  method: WorkspaceExecutionMethod,
  params: Record<string, unknown>,
): Promise<WorkspaceExecutionSelection> {
  if (
    !isAbsolute(options.socketPath) ||
    options.token.length < 32 ||
    typeof ticket !== "string" ||
    !/^[a-f0-9]{64}$/.test(ticket)
  )
    throw unavailable();
  const body = JSON.stringify({ ticket, digest: fingerprint(method, params) });
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath: options.socketPath,
        path: "/consume",
        method: "POST",
        headers: {
          authorization: `Bearer ${options.token}`,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let bytes = 0;
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes > limit) {
            res.destroy();
            req.destroy();
            reject(unavailable());
          } else chunks.push(chunk);
        });
        res.on("error", () => reject(unavailable()));
        res.on("end", () => {
          try {
            if (res.statusCode !== 200) throw unavailable();
            resolve(validateWorkspaceExecutionSelection(JSON.parse(Buffer.concat(chunks).toString("utf8"))));
          } catch {
            reject(unavailable());
          }
        });
      },
    );
    const timer = setTimeout(() => {
      req.destroy();
      reject(unavailable());
    }, 10_000);
    timer.unref();
    req.once("close", () => clearTimeout(timer));
    req.once("error", () => reject(unavailable()));
    req.end(body);
  });
}
