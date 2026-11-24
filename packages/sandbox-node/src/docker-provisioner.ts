import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { isAbsolute, join } from "node:path";
import {
  SandboxCreationFault,
  SandboxFault,
  isWorkspaceId,
  type SandboxBackend,
  type SandboxEnvironment,
  type SandboxReceipt,
  type SandboxResources,
} from "@opencraft/sandbox";
import type { SandboxProviderDefinition, SandboxProviderInstallation } from "@opencraft/sandbox/providers";
import { bindSandboxLink, readSandboxLinkTicket, SANDBOX_LINK_SOCKET } from "./static-docker.js";

/** `docker-provisioner`: workspace containers created on demand by a separate
 * provisioner service, the only component holding the Docker socket. The Host
 * (Gateway) never holds it: it asks the provisioner for one of four operations on a
 * workspace id over a private Unix socket, and reaches the created container exactly
 * like `static-docker` — through its `workspace-agent`'s link (one-time ticket, one
 * session per Host, shared broker), in a per-workspace directory of a links volume the
 * provisioner mounts into that container alone.
 *
 * Provisioner protocol 1: one request line and one answer line per connection.
 * Request `{protocol, op, workspace, image?, nonce, issuedAt, mac}`; `op` is `ensure`
 * (create or start the workspace's container from an allow-listed image alias),
 * `inspect`, `stop` or `destroy`. `mac` is HMAC-SHA256 over the canonical request with
 * the provisioner's request key. Callers never pass Docker parameters: image, command,
 * user, budget, mounts and network come from the provisioner's own policy. */

export const DOCKER_PROVISIONER_PROTOCOL = 1;
export const DOCKER_PROVISIONER_SOCKET = "provisioner.sock";
export const DOCKER_PROVISIONER_KEY = "request.key";
export const DOCKER_PROVISIONER_OPERATIONS = Object.freeze(["ensure", "inspect", "stop", "destroy"] as const);
export type DockerProvisionerOperation = (typeof DOCKER_PROVISIONER_OPERATIONS)[number];
/** An image alias of the provisioner's allow-list (also the `docker-provisioner://<alias>` target). */
export const DOCKER_PROVISIONER_ALIAS = /^[a-z0-9][a-z0-9-]{0,30}$/u;
/** Requests older or newer than this are refused (bounds the replay window). */
export const DOCKER_PROVISIONER_CLOCK_SKEW_MS = 30_000;

export interface DockerProvisionerRequest {
  readonly protocol: typeof DOCKER_PROVISIONER_PROTOCOL;
  readonly op: DockerProvisionerOperation;
  readonly workspace: string;
  readonly image?: string;
  readonly nonce: string;
  readonly issuedAt: number;
  readonly mac: string;
}
export interface DockerProvisionerContainer {
  /** Docker container id (64 hex) or absent. */
  readonly id?: string;
  readonly state: "running" | "stopped" | "absent";
  readonly image?: string;
}
export type DockerProvisionerAnswer =
  | { readonly protocol: 1; readonly ok: true; readonly container: DockerProvisionerContainer }
  | { readonly protocol: 1; readonly ok: false; readonly code: string; readonly message: string };

export function dockerProvisionerCanonical(request: Omit<DockerProvisionerRequest, "mac" | "protocol">): string {
  return [
    `opencraft-docker-provisioner/${DOCKER_PROVISIONER_PROTOCOL}`,
    request.op,
    request.workspace,
    request.image ?? "",
    request.nonce,
    String(request.issuedAt),
  ].join("\n");
}
export function signDockerProvisionerRequest(
  key: string,
  request: Omit<DockerProvisionerRequest, "mac" | "protocol" | "nonce" | "issuedAt">,
  now = Date.now(),
): DockerProvisionerRequest {
  const unsigned = { ...request, nonce: randomBytes(16).toString("hex"), issuedAt: now };
  return {
    protocol: DOCKER_PROVISIONER_PROTOCOL,
    ...unsigned,
    mac: createHmac("sha256", key).update(dockerProvisionerCanonical(unsigned)).digest("hex"),
  };
}
export function verifyDockerProvisionerMac(key: string, request: DockerProvisionerRequest): boolean {
  const expected = createHmac("sha256", key).update(dockerProvisionerCanonical(request)).digest();
  const given = Buffer.from(request.mac, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Reads the request key the provisioner wrote into the shared control directory. */
export async function readDockerProvisionerKey(directory: string): Promise<string> {
  const path = join(directory, DOCKER_PROVISIONER_KEY);
  const info = await lstat(path);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o077) !== 0 ||
    info.size > 256
  )
    throw new SandboxFault("SANDBOX_UNAVAILABLE", "Docker provisioner request key is unavailable");
  const key = (await readFile(path, "utf8")).trim();
  if (!/^[a-f0-9]{64}$/u.test(key))
    throw new SandboxFault("SANDBOX_UNAVAILABLE", "Docker provisioner request key is invalid");
  return key;
}

export class DockerProvisionerFault extends Error {
  constructor(
    readonly code: string,
    message: string,
    /** True when the request may have reached the provisioner (outcome unknown). */
    readonly sent: boolean,
  ) {
    super(message);
    this.name = "DockerProvisionerFault";
  }
}

const CONTAINER_ID = /^[a-f0-9]{64}$/u;
function parseAnswer(line: string): DockerProvisionerAnswer {
  const value = JSON.parse(line) as Record<string, unknown>;
  if (!value || typeof value !== "object" || value.protocol !== DOCKER_PROVISIONER_PROTOCOL) throw Error();
  if (value.ok === false && typeof value.code === "string" && typeof value.message === "string")
    return { protocol: 1, ok: false, code: value.code.slice(0, 64), message: value.message.slice(0, 512) };
  const container = value.container as Record<string, unknown> | undefined;
  if (
    value.ok !== true ||
    !container ||
    !["running", "stopped", "absent"].includes(container.state as string) ||
    (container.id !== undefined && !CONTAINER_ID.test(container.id as string)) ||
    (container.state !== "absent" && container.id === undefined) ||
    (container.image !== undefined && !DOCKER_PROVISIONER_ALIAS.test(container.image as string))
  )
    throw Error();
  return {
    protocol: 1,
    ok: true,
    container: Object.freeze({
      state: container.state as DockerProvisionerContainer["state"],
      ...(container.id ? { id: container.id as string } : {}),
      ...(container.image ? { image: container.image as string } : {}),
    }),
  };
}

/** Host-side client: signs each request with the key from the control directory. */
export function dockerProvisionerClient(options: { directory: string; timeoutMs?: number }) {
  if (!isAbsolute(options?.directory)) throw new SandboxFault("SANDBOX_POLICY", "Invalid docker provisioner directory");
  const socketPath = join(options.directory, DOCKER_PROVISIONER_SOCKET);
  return {
    async request(
      op: DockerProvisionerOperation,
      workspace: string,
      image?: string,
      timeoutMs = options.timeoutMs ?? 120_000,
    ): Promise<DockerProvisionerContainer> {
      let key: string;
      try {
        key = await readDockerProvisionerKey(options.directory);
      } catch (error) {
        throw new DockerProvisionerFault("unavailable", (error as Error).message, false);
      }
      const request = signDockerProvisionerRequest(key, { op, workspace, ...(image ? { image } : {}) });
      const answer = await new Promise<DockerProvisionerAnswer>((resolve, reject) => {
        let text = "",
          sent = false;
        const socket = createConnection({ path: socketPath });
        const timer = setTimeout(() => {
          socket.destroy();
          reject(new DockerProvisionerFault("timeout", "Docker provisioner did not answer", sent));
        }, timeoutMs);
        socket.setEncoding("utf8");
        socket.once("error", (error) => {
          clearTimeout(timer);
          const refused = ["ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code ?? "");
          reject(new DockerProvisionerFault("unavailable", "Docker provisioner is unreachable", sent && !refused));
        });
        socket.once("connect", () => {
          sent = true;
          socket.write(JSON.stringify(request) + "\n");
        });
        socket.on("data", (chunk: string) => {
          text += chunk;
          if (text.length > 16 * 1024) socket.destroy(Error("oversized answer"));
          const end = text.indexOf("\n");
          if (end < 0) return;
          clearTimeout(timer);
          socket.destroy();
          try {
            resolve(parseAnswer(text.slice(0, end)));
          } catch {
            reject(new DockerProvisionerFault("protocol", "Docker provisioner answered with an invalid frame", true));
          }
        });
        socket.once("end", () => {
          clearTimeout(timer);
          reject(new DockerProvisionerFault("protocol", "Docker provisioner closed without an answer", sent));
        });
      });
      // An explicit refusal means the provisioner decided; nothing was left half-done by it.
      if (!answer.ok) throw new DockerProvisionerFault(answer.code, answer.message, false);
      return answer.container;
    },
  };
}

export interface DockerProvisionerBackendOptions {
  /** Control directory shared with the provisioner (its socket and request key). */
  readonly directory: string;
  /** Root of the per-workspace link directories as mounted in the Host. */
  readonly linkRoot: string;
  /** Allow-listed image alias (the environment URI target). */
  readonly image: string;
  /** Resolves the workspace this backend places (one backend per workspace). */
  workspaceId(identity: { readonly id: string; readonly owner: string }): Promise<string | undefined>;
  readonly requestTimeoutMs?: number;
  /** How long a started container may take until its agent serves the link. */
  readonly startTimeoutMs?: number;
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const fault = (code: ConstructorParameters<typeof SandboxFault>[0], message: string) => new SandboxFault(code, message);
/** `<container id>:<agent incarnation>`: the same container and the same agent run. */
const RECEIPT = /^([a-f0-9]{64}):([a-f0-9]{32})$/u;

/** Host side of `docker-provisioner`. `create` asks the provisioner to ensure the
 * workspace's container (create it, or start a stopped one) and binds whichever agent
 * incarnation then serves the link. `attach(receipt)` succeeds only when the same
 * container is still running and its agent is the same incarnation; it never starts or
 * creates. `close` ends this Host's link session and processes (the container stays for
 * a re-attach, like `static-docker`); `sleep` stops the container keeping its volume;
 * `discard` removes the container, its volume and its link directory. */
export function dockerProvisionerSandboxBackend(options: DockerProvisionerBackendOptions): SandboxBackend {
  if (!isAbsolute(options?.directory) || !isAbsolute(options.linkRoot) || !DOCKER_PROVISIONER_ALIAS.test(options.image))
    throw fault("SANDBOX_POLICY", "Invalid docker-provisioner configuration");
  const client = dockerProvisionerClient({ directory: options.directory });
  const requestTimeoutMs = options.requestTimeoutMs ?? 15_000,
    startTimeoutMs = options.startTimeoutMs ?? 120_000;
  const workspaces = new WeakMap<SandboxEnvironment, string>();
  let closed = false;
  const workspaceOf = async (identity: { id: string; owner: string }) => {
    const id = await options.workspaceId(identity);
    if (!isWorkspaceId(id)) throw fault("SANDBOX_POLICY", "docker-provisioner needs the workspace it places");
    return id;
  };
  const linkDirectory = (workspace: string) => join(options.linkRoot, workspace);
  const bind = async (workspace: string, container: string, resources: SandboxResources, expected?: string) => {
    const { incarnation: _incarnation, ...environment } = await bindSandboxLink(
      {
        socketPath: join(linkDirectory(workspace), SANDBOX_LINK_SOCKET),
        readTicket: () => readSandboxLinkTicket(linkDirectory(workspace)),
        timeoutMs: requestTimeoutMs,
        label: "docker-provisioner",
        receipt: (incarnation): SandboxReceipt => ({
          backend: "docker-provisioner",
          instanceId: `${container}:${incarnation.id}`,
        }),
        ...(expected ? { expected } : {}),
      },
      resources,
    );
    workspaces.set(environment, workspace);
    return environment as SandboxEnvironment;
  };
  /** After a start the agent needs a moment to serve the link (and may first clean a
   * previous incarnation's ticket). Only "not serving yet" is retried. */
  const bindStarted = async (
    workspace: string,
    container: string,
    resources: SandboxResources,
    signal: AbortSignal,
  ) => {
    const deadline = Date.now() + startTimeoutMs;
    for (;;) {
      if (closed || signal.aborted) throw fault("SANDBOX_CLOSED", "docker-provisioner backend is closed");
      try {
        return await bind(workspace, container, resources);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code ?? "";
        const notYet =
          ["ENOENT", "ECONNREFUSED"].includes(code) ||
          (error instanceof SandboxFault &&
            error.code === "SANDBOX_UNAVAILABLE" &&
            /refused the link|ticket/u.test(error.message));
        if (!notYet || Date.now() > deadline) throw error;
        await delay(200);
      }
    }
  };
  return {
    id: "docker-provisioner",
    async initialize(_policy, signal) {
      if (closed || signal.aborted) throw fault("SANDBOX_UNAVAILABLE", "docker-provisioner backend is closed");
    },
    async create(identity, resources, signal) {
      let workspace: string;
      try {
        workspace = await workspaceOf(identity);
      } catch {
        throw new SandboxCreationFault("not-created");
      }
      let container;
      try {
        container = await client.request("ensure", workspace, options.image);
      } catch (error) {
        // A refusal or an unreachable provisioner created nothing; a lost answer may have.
        if (error instanceof DockerProvisionerFault && !error.sent) throw new SandboxCreationFault("not-created");
        throw new SandboxCreationFault("unknown", identity);
      }
      if (container.state !== "running" || !container.id || container.image !== options.image)
        throw new SandboxCreationFault("unknown", identity);
      try {
        return await bindStarted(workspace, container.id, resources, signal);
      } catch (error) {
        // The container exists (it is the workspace's, reused by the next create), but no
        // environment was handed out: nothing of this request is left to reclaim.
        if (error instanceof SandboxFault && error.code === "SANDBOX_POLICY") throw error;
        throw new SandboxCreationFault("not-created");
      }
    },
    async attach(identity, receipt, resources, signal) {
      const match = receipt?.backend === "docker-provisioner" ? RECEIPT.exec(receipt.instanceId) : null;
      if (!match) throw fault("SANDBOX_UNAVAILABLE", "Receipt belongs to another provider");
      if (closed || signal.aborted) throw fault("SANDBOX_CLOSED", "docker-provisioner backend is closed");
      const workspace = await workspaceOf(identity);
      let container;
      try {
        container = await client.request("inspect", workspace);
      } catch {
        throw fault("SANDBOX_UNAVAILABLE", "The docker provisioner cannot confirm the workspace container");
      }
      // Never start a stopped container here: that is a new incarnation (create's job).
      if (container.state !== "running" || container.id !== match[1] || container.image !== options.image)
        throw fault("SANDBOX_UNAVAILABLE", "The workspace container is not the receipt's running instance");
      try {
        return await bind(workspace, match[1]!, resources, match[2]);
      } catch (error) {
        throw error instanceof SandboxFault
          ? error
          : fault("SANDBOX_UNAVAILABLE", "The workspace container is unreachable");
      }
    },
    async sleep(environment) {
      const workspace = workspaces.get(environment);
      if (!workspace) throw fault("SANDBOX_POLICY", "Not a docker-provisioner environment");
      await environment.close();
      try {
        await client.request("stop", workspace);
      } catch (error) {
        throw new SandboxFault("SANDBOX_CLEANUP", "The workspace container did not stop", { cause: error });
      }
    },
    async discard(identity) {
      const workspace = await workspaceOf(identity);
      try {
        await client.request("destroy", workspace);
      } catch (error) {
        throw new SandboxFault("SANDBOX_CLEANUP", "The workspace container was not removed", { cause: error });
      }
    },
    async close() {
      closed = true;
    },
  };
}

export interface DockerProvisionerInstallation extends SandboxProviderInstallation {
  readonly backend: "docker-provisioner";
  /** Control directory shared only with the provisioner service. */
  readonly directory: string;
  /** Root of per-workspace link directories as mounted in the Host. */
  readonly linkRoot: string;
}

/** `docker-provisioner://<alias>`: `aliases` is the deployment's copy of the provisioner's
 * image allow-list (the provisioner checks again; a URI never names an image reference). */
export function dockerProvisionerSandboxProvider(options: {
  aliases: readonly string[];
}): SandboxProviderDefinition<DockerProvisionerInstallation> {
  const aliases = new Set(options.aliases.filter((alias) => DOCKER_PROVISIONER_ALIAS.test(alias)));
  if (!aliases.size || aliases.size !== options.aliases.length)
    throw fault("SANDBOX_POLICY", "docker-provisioner needs a valid image alias allow-list");
  return {
    id: "docker-provisioner",
    acceptsTarget: (target) => aliases.has(target),
    createBackend: (request) => {
      if (!aliases.has(request.templateId) || !request.readWorkspaceId)
        throw fault("SANDBOX_POLICY", "Invalid docker-provisioner environment");
      return dockerProvisionerSandboxBackend({
        directory: request.installation.directory,
        linkRoot: request.installation.linkRoot,
        image: request.templateId,
        workspaceId: (identity) => request.readWorkspaceId!(identity as never),
        requestTimeoutMs: request.requestTimeoutMs,
        startTimeoutMs: request.timeoutMs,
      });
    },
  };
}
