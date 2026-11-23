import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { isAbsolute, join } from "node:path";
import {
  SandboxCreationFault, SandboxFault, SANDBOX_ENDPOINT_NAMES, endpointRelaySource,
  type SandboxBackend, type SandboxEnvironment, type SandboxProcess, type SandboxReceipt, type SandboxResources,
} from "@opencraft/sandbox";
import { brokerSource, startBrokerProcess } from "@opencraft/sandbox/broker";
import type { SandboxProviderDefinition, SandboxProviderInstallation } from "@opencraft/sandbox/providers";
import type { WorkspaceAgentIncarnation } from "@opencraft/sandbox/workspace";

/** `static-docker`: a workspace container declared by Compose. The Host never holds
 * a Docker socket. Instead the container's `workspace-agent` serves the shared
 * process broker on a *link*: a Unix socket in a directory mounted only into the
 * Gateway and that one container (never the shared data directory).
 *
 * Link protocol (one JSON line from the Host per connection, protocol 1):
 * - `attach {ticket, incarnation?}`: the ticket is a one-time secret the agent writes
 *   to `<link>/ticket` (0600) at start and rotates after every successful attach. The
 *   agent answers with its incarnation, effective cgroup limits and a fresh session
 *   key; a newer attach revokes the previous session and kills its processes (fences a
 *   stale Host). With `incarnation`, the agent refuses unless it is that incarnation:
 *   re-attach after a Host restart never binds a restarted container silently.
 * - `open {session}`: after `opened`, the connection carries exactly one broker
 *   process in the shared broker protocol (the same frames as E2B and other
 *   providers). The agent checks the `start` frame against its command policy.
 * - `release {session}`: ends the session and its processes (environment close). */

export const SANDBOX_LINK_PROTOCOL = 1;
export const SANDBOX_LINK_SOCKET = "link.sock";
export const SANDBOX_LINK_TICKET = "ticket";
/** `relay-only` (production): only the fixed endpoint relay to an allow-listed
 * endpoint name. `any`: arbitrary commands (bare/dev images and conformance tests). */
export type SandboxLinkPolicy = "relay-only" | "any";

const fault = (code: ConstructorParameters<typeof SandboxFault>[0], message: string) => new SandboxFault(code, message);
const digest = (value: string) => createHash("sha256").update(value).digest();
const sameSecret = (left: string, right: string) => timingSafeEqual(digest(left), digest(right));

/** Reads one newline-terminated JSON frame; the rest of the stream stays buffered. */
function firstLine(socket: Socket, limit = 512 * 1024, timeoutMs = 15_000, linkFrame = true): Promise<{ value: Record<string, unknown>; rest: Buffer }> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => finish(Error("Link frame timed out")), timeoutMs);
    const finish = (error?: Error, value?: Record<string, unknown>, rest?: Buffer) => {
      clearTimeout(timer); socket.off("data", data); socket.off("end", ended); socket.off("error", finish);
      if (error) reject(error); else resolve({ value: value!, rest: rest! });
    };
    const ended = () => finish(Error("Link closed before a frame"));
    const data = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf(10);
      if (end < 0) { if (buffer.length > limit) finish(Error("Link frame exceeds its budget")); return; }
      socket.pause();
      try {
        const value = JSON.parse(buffer.subarray(0, end).toString("utf8"));
        if (!value || typeof value !== "object" || Array.isArray(value) || linkFrame && value.protocol !== SANDBOX_LINK_PROTOCOL) throw Error();
        finish(undefined, value, buffer.subarray(end + 1));
      } catch { finish(Error("Invalid link frame")); }
    };
    socket.on("data", data); socket.once("end", ended); socket.once("error", finish);
    socket.resume();
  });
}
const frame = (value: Record<string, unknown>) => JSON.stringify({ ...value, protocol: SANDBOX_LINK_PROTOCOL }) + "\n";

async function privateDirectory(path: string) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)
    throw Error("The sandbox link directory must be a private directory owned by this user");
}

export interface SandboxLinkServerOptions {
  /** The link directory: mounted into the Host and this container only. */
  readonly directory: string;
  readonly incarnation: WorkspaceAgentIncarnation;
  /** Interpreter running the shared broker (and the endpoint relay). */
  readonly python: string;
  readonly policy: SandboxLinkPolicy;
  /** Where the agent publishes named endpoints (relay-only targets). */
  readonly endpointDirectory: string;
  /** Effective limits of this environment; `null` dimensions are unlimited. */
  limits(): Promise<{ cpuMillis: number | null; memoryBytes: number | null; tasks: number | null }>;
  readonly log?: (event: Record<string, unknown>) => void;
}

/** Agent side of the link: serves the broker to the one attached Host session. */
export async function serveSandboxLink(options: SandboxLinkServerOptions) {
  if (!isAbsolute(options.directory) || !isAbsolute(options.python) || !isAbsolute(options.endpointDirectory)
    || !["relay-only", "any"].includes(options.policy)) throw Error("Invalid sandbox link configuration");
  await privateDirectory(options.directory);
  // Every open runs the broker under this interpreter: an image without it must fail the
  // agent's start (unhealthy, logged), not accept attaches and then refuse every process.
  try { await access(options.python, constants.X_OK); }
  catch (error) { throw Error(`Sandbox link interpreter ${options.python} is not executable`, { cause: error }); }
  const socketPath = join(options.directory, SANDBOX_LINK_SOCKET), ticketPath = join(options.directory, SANDBOX_LINK_TICKET);
  if (Buffer.byteLength(socketPath) > 107) throw Error("Sandbox link path is too long");
  await rm(socketPath, { force: true }); await rm(ticketPath, { force: true });
  let ticket = "", session: { key: string; epoch: number; brokers: Set<ChildProcess> } | undefined, epoch = 0;
  const log = options.log ?? (() => {});
  const rotate = async () => {
    ticket = randomBytes(32).toString("hex");
    const temporary = `${ticketPath}.${randomBytes(6).toString("hex")}`;
    await writeFile(temporary, ticket + "\n", { mode: 0o600, flag: "wx" });
    await rename(temporary, ticketPath);
  };
  const revoke = (reason: string) => {
    if (!session) return;
    // EOF on its control input makes the broker kill its process's own session (the
    // process runs in a new session, so killing only the broker would orphan it);
    // SIGKILL is the fallback for a broker that does not exit.
    for (const broker of session.brokers) {
      broker.stdin?.end();
      setTimeout(() => { try { broker.kill("SIGKILL"); } catch {} }, 5_000).unref();
    }
    log({ type: "sandbox-link-session-ended", epoch: session.epoch, reason });
    session = undefined;
  };
  const allowed = (start: Record<string, unknown>) => {
    if (start.type !== "start" || !start.command || typeof start.command !== "object") return false;
    if (options.policy === "any") return true;
    const command = start.command as { command?: unknown; terminal?: unknown; env?: unknown };
    const argv = command.command;
    return Array.isArray(argv) && argv.length === 6 && !command.terminal
      && argv[0] === options.python && argv[1] === "-I" && argv[2] === "-u" && argv[3] === "-c" && argv[4] === endpointRelaySource
      && SANDBOX_ENDPOINT_NAMES.some(name => argv[5] === `${options.endpointDirectory}/${name}`)
      && !!command.env && typeof command.env === "object" && Object.keys(command.env).length === 0;
  };
  const sockets = new Set<Socket>();
  const handle = async (socket: Socket) => {
    const { value, rest } = await firstLine(socket, 4096, 5_000);
    if (value.type === "attach" && typeof value.ticket === "string") {
      if (!ticket || !sameSecret(value.ticket, ticket)) { socket.end(frame({ type: "rejected", reason: "ticket" })); return; }
      await rotate(); // One-time: a copied ticket is useless after this attach.
      if (value.incarnation !== undefined && value.incarnation !== options.incarnation.id) {
        socket.end(frame({ type: "rejected", reason: "incarnation", incarnation: options.incarnation }));
        return;
      }
      revoke("superseded");
      session = { key: randomBytes(32).toString("hex"), epoch: ++epoch, brokers: new Set() };
      const limits = await options.limits();
      log({ type: "sandbox-link-attached", epoch: session.epoch });
      socket.end(frame({ type: "attached", incarnation: options.incarnation, session: session.key, epoch: session.epoch,
        limits, terminal: options.policy === "any" }));
      return;
    }
    const current = session;
    if (typeof value.session !== "string" || !current || !sameSecret(value.session, current.key)) {
      socket.end(frame({ type: "rejected", reason: "session" })); return;
    }
    if (value.type === "release") { revoke("released"); socket.end(frame({ type: "released" })); return; }
    if (value.type !== "open") { socket.destroy(); return; }
    socket.write(frame({ type: "opened" }));
    socket.unshift(rest);
    // The next frame is the broker's own `start` frame (broker protocol, not a link frame).
    const { value: start, rest: input } = await firstLine(socket, 400_000, 15_000, false);
    // Refusals answer with a broker-protocol error frame so the Host reports why.
    const refuse = (reason: string) => socket.end(JSON.stringify({ type: "error", reason }) + "\n");
    if (session !== current) { refuse("session"); return; }
    if (!allowed(start)) { log({ type: "sandbox-link-open-refused", epoch: current.epoch, reason: "policy" }); refuse("policy"); return; }
    const broker = spawn(options.python, ["-u", "-c", brokerSource], { stdio: ["pipe", "pipe", "ignore"], cwd: "/", env: process.env });
    current.brokers.add(broker);
    broker.once("close", () => { current.brokers.delete(broker); socket.end(); });
    broker.once("error", error => {
      current.brokers.delete(broker);
      log({ type: "sandbox-link-broker-failed", epoch: current.epoch, code: (error as NodeJS.ErrnoException).code ?? "unknown" });
      refuse("broker-unavailable");
    });
    broker.stdin.on("error", () => {});
    broker.stdin.write(JSON.stringify(start) + "\n");
    if (input.length) broker.stdin.write(input);
    broker.stdout.pipe(socket);
    socket.on("data", chunk => { if (!broker.stdin.write(chunk)) { socket.pause(); broker.stdin.once("drain", () => socket.resume()); } });
    // Losing the Host stream EOFs the broker's control input: the broker kills its process group.
    socket.once("close", () => { broker.stdin.end(); setTimeout(() => { try { broker.kill("SIGKILL"); } catch {} }, 5_000).unref(); });
    socket.resume();
  };
  const server: Server = createServer({ allowHalfOpen: true }, socket => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    handle(socket).catch(() => socket.destroy());
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, () => { server.off("error", reject); resolve(); }); });
  await chmod(socketPath, 0o600);
  // The ticket appears last: its presence means the link is accepting.
  await rotate();
  let closing: Promise<void> | undefined;
  return {
    path: socketPath,
    close: () => closing ??= (async () => {
      revoke("agent-stopping");
      await new Promise<void>(resolve => { server.close(() => resolve()); for (const socket of sockets) socket.destroy(); });
      await rm(ticketPath, { force: true }); await rm(socketPath, { force: true });
    })(),
  };
}

export async function readSandboxLinkTicket(directory: string): Promise<string> {
  const path = join(directory, SANDBOX_LINK_TICKET);
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || info.size > 256)
    throw fault("SANDBOX_UNAVAILABLE", "Sandbox link ticket is unavailable");
  return (await readFile(path, "utf8")).trim();
}

/** One request/answer on a fresh link connection. */
function linkRequest(socketPath: string, value: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path: socketPath, allowHalfOpen: true });
    const timer = setTimeout(() => socket.destroy(Error("Link request timed out")), timeoutMs);
    socket.once("error", error => { clearTimeout(timer); reject(error); });
    socket.once("connect", () => {
      socket.write(frame(value));
      firstLine(socket, 64 * 1024, timeoutMs).then(({ value: answer }) => { clearTimeout(timer); socket.destroy(); resolve(answer); },
        error => { clearTimeout(timer); socket.destroy(); reject(error); });
    });
  });
}
const gone = (error: unknown) => ["ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException)?.code ?? "");

export interface StaticDockerBackendOptions {
  /** The container's link directory as mounted in the Host. */
  readonly directory: string;
  /** Defaults to reading `<directory>/ticket`. */
  readTicket?(): Promise<string>;
  readonly requestTimeoutMs?: number;
}

/** Host side. `create` binds whichever agent incarnation currently runs (nothing is
 * created: the container is declared); `attach(receipt)` binds only the incarnation
 * the receipt names. `close` ends this Host's session and processes; the declared
 * container is not removed (only its Compose project can do that). */
export function staticDockerSandboxBackend(options: StaticDockerBackendOptions): SandboxBackend {
  if (!isAbsolute(options?.directory)) throw fault("SANDBOX_POLICY", "Invalid static-docker link directory");
  const socketPath = join(options.directory, SANDBOX_LINK_SOCKET);
  const timeoutMs = options.requestTimeoutMs ?? 15_000;
  const readTicket = options.readTicket ?? (() => readSandboxLinkTicket(options.directory));
  let closed = false;
  const bind = async (resources: SandboxResources, signal: AbortSignal, expected?: string): Promise<SandboxEnvironment> => {
    if (closed || signal.aborted) throw fault("SANDBOX_CLOSED", "static-docker backend is closed");
    const answer = await linkRequest(socketPath, { type: "attach", ticket: await readTicket(), ...(expected ? { incarnation: expected } : {}) }, timeoutMs);
    if (answer.type === "rejected") throw fault("SANDBOX_UNAVAILABLE", answer.reason === "incarnation"
      ? "The declared container runs a different incarnation" : "The declared container refused the link");
    const incarnation = answer.incarnation as WorkspaceAgentIncarnation | undefined, limits = answer.limits as Record<string, unknown> | undefined;
    if (answer.type !== "attached" || typeof answer.session !== "string" || answer.session.length !== 64
      || typeof incarnation?.id !== "string" || !/^[a-f0-9]{32}$/u.test(incarnation.id) || expected && incarnation.id !== expected || !limits)
      throw fault("SANDBOX_UNAVAILABLE", "The declared container returned an invalid link identity");
    const session = answer.session, receipt: SandboxReceipt = Object.freeze({ backend: "static-docker", instanceId: incarnation.id });
    // Compose applies the limits before the agent starts; the declared budget must be what is enforced.
    if (limits.cpuMillis !== resources.cpuMillis || limits.memoryBytes !== resources.memoryBytes) {
      await linkRequest(socketPath, { type: "release", session }, timeoutMs).catch(() => {});
      throw fault("SANDBOX_POLICY", "The declared container does not enforce the requested budget");
    }
    const channels = new Set<Promise<unknown>>();
    let ended = false, closing: Promise<void> | undefined;
    const environment: SandboxEnvironment = {
      receipt, resources: Object.freeze({ cpuMillis: resources.cpuMillis, memoryBytes: resources.memoryBytes }),
      capabilities: { terminal: answer.terminal === true },
      ...(Number.isSafeInteger(limits.tasks) ? { processLimits: { tasks: limits.tasks as number, fileDescriptorsPerProcess: 65536 } } : {}),
      async spawn(command, onOutput): Promise<SandboxProcess> {
        if (ended) throw fault("SANDBOX_CLOSED", "static-docker environment is closed");
        return startBrokerProcess({
          id: randomBytes(12).toString("hex"), command, onOutput, requestTimeoutMs: timeoutMs, label: "static-docker",
          closeEnvironment: () => environment.close(),
          launch: onStdout => new Promise((resolve, reject) => {
            const socket = createConnection({ path: socketPath, allowHalfOpen: true });
            const end = new Promise<void>(settle => socket.once("close", () => settle()));
            socket.once("error", reject);
            socket.once("connect", () => {
              socket.write(frame({ type: "open", session }));
              firstLine(socket, 4096, timeoutMs).then(({ value, rest }) => {
                if (value.type !== "opened") { socket.destroy(); reject(fault("SANDBOX_START", "static-docker link refused the process")); return; }
                socket.setEncoding("utf8");
                socket.on("data", onStdout);
                if (rest.length) onStdout(rest.toString("utf8"));
                socket.on("error", () => {});
                // The broker ended (the agent half-closed): finish our side so `ended` settles.
                socket.once("end", () => socket.end());
                socket.resume();
                channels.add(end); void end.finally(() => channels.delete(end));
                resolve({
                  ended: end,
                  write: data => new Promise<void>((accept, fail) => {
                    if (socket.destroyed || !socket.writable) { fail(Error("Link stream closed")); return; }
                    socket.write(data, error => error ? fail(error) : accept());
                  }),
                });
              }, error => { socket.destroy(); reject(error); });
            });
          }),
        });
      },
      close: () => closing ??= (async () => {
        ended = true;
        try { await linkRequest(socketPath, { type: "release", session }, timeoutMs); }
        catch (error) {
          // The agent is the container's main process: no listener means no processes.
          if (!gone(error)) throw fault("SANDBOX_CLEANUP", "static-docker session release is unconfirmed");
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        const settled = await Promise.race([Promise.allSettled([...channels]).then(() => true),
          new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); })]);
        clearTimeout(timer);
        if (!settled) throw fault("SANDBOX_CLEANUP", "static-docker processes did not end");
      })(),
    };
    return environment;
  };
  return {
    id: "static-docker",
    async initialize(_policy, signal) { if (closed || signal.aborted) throw fault("SANDBOX_UNAVAILABLE", "static-docker backend is closed"); },
    async create(_identity, resources, signal) {
      // Binding a declared container creates nothing, so every failure is "not created".
      try { return await bind(resources, signal); }
      catch { throw new SandboxCreationFault("not-created"); }
    },
    async attach(_identity, receipt, resources, signal) {
      if (receipt?.backend !== "static-docker") throw fault("SANDBOX_UNAVAILABLE", "Receipt belongs to another provider");
      try { return await bind(resources, signal, receipt.instanceId); }
      catch (error) { throw error instanceof SandboxFault ? error : fault("SANDBOX_UNAVAILABLE", "The declared container is unreachable"); }
    },
    async close() { closed = true; },
  };
}

export interface StaticDockerInstallation extends SandboxProviderInstallation {
  readonly backend: "static-docker";
  /** Host directory holding one link directory per declared service. */
  readonly linkRoot: string;
}
const SERVICE = /^[a-z0-9][a-z0-9_.-]{0,62}$/u;
/** `static-docker://<service>`: the service's link directory is `<linkRoot>/<service>`. */
export function staticDockerSandboxProvider(): SandboxProviderDefinition<StaticDockerInstallation> {
  return {
    id: "static-docker",
    acceptsTarget: target => SERVICE.test(target),
    createBackend: request => {
      if (!SERVICE.test(request.templateId) || !isAbsolute(request.installation.linkRoot)) throw fault("SANDBOX_POLICY", "Invalid static-docker service");
      return staticDockerSandboxBackend({ directory: join(request.installation.linkRoot, request.templateId), requestTimeoutMs: request.requestTimeoutMs });
    },
  };
}
