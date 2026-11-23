import { randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { chmod, chown, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { isAbsolute, join, normalize } from "node:path";
import { isWorkspaceId } from "@opencraft/sandbox";
import {
  DOCKER_PROVISIONER_ALIAS,
  DOCKER_PROVISIONER_CLOCK_SKEW_MS,
  DOCKER_PROVISIONER_KEY,
  DOCKER_PROVISIONER_OPERATIONS,
  DOCKER_PROVISIONER_PROTOCOL,
  DOCKER_PROVISIONER_SOCKET,
  verifyDockerProvisionerMac,
  type DockerProvisionerContainer,
  type DockerProvisionerOperation,
  type DockerProvisionerRequest,
} from "./docker-provisioner.js";

/** The provisioner service: the only holder of the Docker socket in a multi-workspace
 * Docker deployment. It turns four signed workspace operations into Docker Engine API
 * calls whose every parameter comes from its own policy; it never pulls images, never
 * accepts a mount, command, user, device, capability or network from a caller, and only
 * touches containers, volumes and networks carrying its deployment label. */

/** Paths inside workspace containers the provisioner owns (fixed, not policy). */
export const PROVISIONED_LINK_TARGET = "/run/opencraft-link";
export const PROVISIONED_AGENT_RUN = "/run/opencraft-agent";
const RESERVED_ENV = new Set(["OPENCRAFT_AGENT_LINK_DIR", "OPENCRAFT_AGENT_RUN_DIR"]);
const FORBIDDEN_SOURCES = [
  "/proc",
  "/sys",
  "/dev",
  "/etc",
  "/boot",
  "/root",
  "/run",
  "/var/run",
  "/var/lib/docker",
  "/var/lib/containerd",
];
const FORBIDDEN_TARGETS = ["/proc", "/sys", "/dev", PROVISIONED_LINK_TARGET, PROVISIONED_AGENT_RUN];
const IMAGE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,254}$/u;
const DEPLOYMENT = /^[a-z0-9][a-z0-9-]{0,30}$/u;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;

export interface ProvisionedImagePolicy {
  /** Local image reference (tag or digest). The provisioner never pulls. */
  readonly image: string;
  /** Container entry: the image's `workspace-agent` (fixed argv). */
  readonly command: readonly string[];
  /** `uid:gid`; UID 0 only with `root: true`. */
  readonly user: string;
  readonly root?: boolean;
  readonly cpuMillis: number;
  readonly memoryBytes: number;
  readonly pidsLimit: number;
  /** Where the workspace's named volume (a cache; Git is the content truth) is mounted. */
  readonly volumeTarget: string;
  readonly env: Readonly<Record<string, string>>;
  /** Operator-declared read-only or read-write bind mounts (absolute host paths). */
  readonly mounts?: readonly { readonly source: string; readonly target: string; readonly readOnly: boolean }[];
}
export interface DockerProvisionerPolicy {
  /** Label value and container-name prefix; the provisioner manages only its own objects. */
  readonly deployment: string;
  readonly maxWorkspaces: number;
  /** `none`, or a bridge network the provisioner creates with inter-container traffic disabled. */
  readonly network: string;
  readonly internalNetwork?: boolean;
  /** Docker-side source of the per-workspace link directories: a named volume (mounted by
   * subpath) or a host directory (bind). */
  readonly links: { readonly volume: string } | { readonly directory: string };
  /** The same links root as mounted in this service (where it creates `<workspace>/`). */
  readonly linkDirectory: string;
  readonly images: Readonly<Record<string, ProvisionedImagePolicy>>;
}

const within = (path: string, root: string) => path === root || path.startsWith(root + "/");
const absolutePath = (value: unknown): value is string =>
  typeof value === "string" &&
  isAbsolute(value) &&
  normalize(value) === value &&
  value !== "/" &&
  !value.includes("\0");
const positive = (value: unknown, max: number): value is number =>
  Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= max;

/** Strict policy validation: unknown keys, unsafe mounts or a root user without consent fail. */
export function parseDockerProvisionerPolicy(input: unknown): DockerProvisionerPolicy {
  const invalid = (what: string) => new Error(`Invalid docker provisioner policy: ${what}`);
  const object = (value: unknown, keys: readonly string[], what: string) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid(what);
    for (const key of Object.keys(value)) if (!keys.includes(key)) throw invalid(`${what}.${key}`);
    return value as Record<string, unknown>;
  };
  const policy = object(
    input,
    ["deployment", "maxWorkspaces", "network", "internalNetwork", "links", "linkDirectory", "images"],
    "policy",
  );
  if (typeof policy.deployment !== "string" || !DEPLOYMENT.test(policy.deployment)) throw invalid("deployment");
  if (!positive(policy.maxWorkspaces, 1024)) throw invalid("maxWorkspaces");
  if (typeof policy.network !== "string" || !NAME.test(policy.network) || ["host", "bridge"].includes(policy.network))
    throw invalid("network");
  if (policy.internalNetwork !== undefined && typeof policy.internalNetwork !== "boolean")
    throw invalid("internalNetwork");
  const links = object(policy.links, ["volume", "directory"], "links");
  if (Object.keys(links).length !== 1) throw invalid("links");
  if (links.volume !== undefined && (typeof links.volume !== "string" || !NAME.test(links.volume)))
    throw invalid("links.volume");
  if (links.directory !== undefined && !absolutePath(links.directory)) throw invalid("links.directory");
  if (!absolutePath(policy.linkDirectory)) throw invalid("linkDirectory");
  const images = object(policy.images, Object.keys(policy.images ?? {}), "images");
  if (!Object.keys(images).length || Object.keys(images).length > 32) throw invalid("images");
  const parsed: Record<string, ProvisionedImagePolicy> = {};
  for (const [alias, raw] of Object.entries(images)) {
    if (!DOCKER_PROVISIONER_ALIAS.test(alias)) throw invalid(`images.${alias}`);
    const spec = object(
      raw,
      ["image", "command", "user", "root", "cpuMillis", "memoryBytes", "pidsLimit", "volumeTarget", "env", "mounts"],
      `images.${alias}`,
    );
    if (typeof spec.image !== "string" || !IMAGE_REFERENCE.test(spec.image)) throw invalid(`images.${alias}.image`);
    if (
      !Array.isArray(spec.command) ||
      !spec.command.length ||
      spec.command.length > 32 ||
      !spec.command.every(
        (part) => typeof part === "string" && part.length > 0 && part.length <= 1024 && !part.includes("\0"),
      ) ||
      !isAbsolute(spec.command[0] as string)
    )
      throw invalid(`images.${alias}.command`);
    const user = typeof spec.user === "string" ? /^(\d{1,10}):(\d{1,10})$/u.exec(spec.user) : null;
    if (!user || Number(user[1]) > 2 ** 31 - 1 || Number(user[2]) > 2 ** 31 - 1) throw invalid(`images.${alias}.user`);
    if (spec.root !== undefined && spec.root !== true) throw invalid(`images.${alias}.root`);
    if ((user[1] === "0" || user[2] === "0") && spec.root !== true)
      throw invalid(`images.${alias}.user (root needs root: true)`);
    if (
      !positive(spec.cpuMillis, 1024_000) ||
      !positive(spec.memoryBytes, 2 ** 50) ||
      !positive(spec.pidsLimit, 1 << 22)
    )
      throw invalid(`images.${alias} budget`);
    if (!absolutePath(spec.volumeTarget) || FORBIDDEN_TARGETS.some((root) => within(spec.volumeTarget as string, root)))
      throw invalid(`images.${alias}.volumeTarget`);
    const env = object(spec.env, Object.keys(spec.env ?? {}), `images.${alias}.env`);
    if (Object.keys(env).length > 64) throw invalid(`images.${alias}.env`);
    for (const [name, value] of Object.entries(env))
      if (
        !ENV_NAME.test(name) ||
        RESERVED_ENV.has(name) ||
        typeof value !== "string" ||
        value.length > 4096 ||
        value.includes("\0")
      )
        throw invalid(`images.${alias}.env.${name}`);
    const mounts = spec.mounts ?? [];
    if (!Array.isArray(mounts) || mounts.length > 8) throw invalid(`images.${alias}.mounts`);
    const parsedMounts = mounts.map((value, index) => {
      const mount = object(value, ["source", "target", "readOnly"], `images.${alias}.mounts.${index}`);
      if (
        !absolutePath(mount.source) ||
        !absolutePath(mount.target) ||
        typeof mount.readOnly !== "boolean" ||
        /docker\.sock|containerd/u.test(mount.source) ||
        FORBIDDEN_SOURCES.some((root) => within(mount.source as string, root)) ||
        FORBIDDEN_TARGETS.some(
          (root) => within(mount.target as string, root) || within(root, mount.target as string),
        ) ||
        within(mount.target, spec.volumeTarget as string) ||
        within(spec.volumeTarget as string, mount.target)
      )
        throw invalid(`images.${alias}.mounts.${index}`);
      return Object.freeze({ source: mount.source, target: mount.target, readOnly: mount.readOnly });
    });
    parsed[alias] = Object.freeze({
      image: spec.image,
      command: Object.freeze([...(spec.command as string[])]),
      user: spec.user as string,
      ...(spec.root ? { root: true } : {}),
      cpuMillis: spec.cpuMillis as number,
      memoryBytes: spec.memoryBytes as number,
      pidsLimit: spec.pidsLimit as number,
      volumeTarget: spec.volumeTarget as string,
      env: Object.freeze({ ...(env as Record<string, string>) }),
      ...(parsedMounts.length ? { mounts: Object.freeze(parsedMounts) } : {}),
    });
  }
  return Object.freeze({
    deployment: policy.deployment,
    maxWorkspaces: policy.maxWorkspaces,
    network: policy.network,
    ...(policy.internalNetwork ? { internalNetwork: true } : {}),
    links: Object.freeze(
      links.volume !== undefined ? { volume: links.volume as string } : { directory: links.directory as string },
    ),
    linkDirectory: policy.linkDirectory,
    images: Object.freeze(parsed),
  });
}

/** The fields of Docker Engine answers this service reads; everything else is ignored. */
export interface DockerAnswer {
  readonly status: number;
  readonly body?: {
    readonly Id?: string;
    readonly message?: string;
    readonly Driver?: string;
    readonly Labels?: Record<string, string>;
    readonly Config?: { readonly Labels?: Record<string, string> };
    readonly State?: { readonly Running?: boolean };
    readonly length?: number;
  };
}
/** Minimal Docker Engine API client over the daemon's Unix socket. */
export interface DockerEngine {
  call(method: string, path: string, body?: unknown): Promise<DockerAnswer>;
}
export function dockerEngine(socketPath: string, { version = "v1.45", timeoutMs = 120_000 } = {}): DockerEngine {
  if (!isAbsolute(socketPath)) throw new Error("The Docker socket path must be absolute");
  return {
    call: (method, path, body) =>
      new Promise((resolve, reject) => {
        const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
        const request = httpRequest(
          {
            socketPath,
            method,
            path: `/${version}${path}`,
            headers: payload ? { "content-type": "application/json", "content-length": payload.length } : {},
            timeout: timeoutMs,
          },
          (response) => {
            const chunks: Buffer[] = [];
            let size = 0;
            response.on("data", (chunk: Buffer) => {
              size += chunk.length;
              if (size > 4 * 1024 * 1024) request.destroy(Error("Docker answer exceeds its budget"));
              else chunks.push(chunk);
            });
            response.on("end", () => {
              const text = Buffer.concat(chunks).toString("utf8");
              let parsed: unknown = text;
              try {
                parsed = text ? JSON.parse(text) : undefined;
              } catch {}
              resolve({ status: response.statusCode ?? 0, body: parsed as DockerAnswer["body"] });
            });
            response.on("error", reject);
          },
        );
        request.on("timeout", () => request.destroy(Error("Docker request timed out")));
        request.on("error", reject);
        request.end(payload);
      }),
  };
}

class Refusal extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
const ok = (status: number) => status >= 200 && status < 300;
const dockerFailure = (what: string, answer: DockerAnswer) =>
  new Refusal(
    "docker",
    `${what} failed (${answer.status}${typeof answer.body?.message === "string" ? `: ${answer.body.message.slice(0, 200)}` : ""})`,
  );

export interface DockerProvisionerServiceOptions {
  /** Private control directory shared only with the Gateway (socket and request key). */
  readonly directory: string;
  readonly policy: DockerProvisionerPolicy;
  readonly docker: DockerEngine;
  readonly log?: (event: Record<string, unknown>) => void;
  readonly now?: () => number;
  readonly maxConnections?: number;
}

const LABEL = {
  provisioner: "org.opencraft.provisioner",
  workspace: "org.opencraft.workspace",
  image: "org.opencraft.image-alias",
};

export async function serveDockerProvisioner(options: DockerProvisionerServiceOptions) {
  const { policy, docker } = options;
  const log = options.log ?? ((event) => console.log(JSON.stringify(event)));
  const now = options.now ?? Date.now;
  const uid = process.getuid?.() ?? -1;
  const info = await lstat(options.directory);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== uid || (info.mode & 0o077) !== 0)
    throw new Error("The provisioner control directory must be a private directory owned by this user");
  const linkRoot = await lstat(policy.linkDirectory);
  if (!linkRoot.isDirectory() || linkRoot.isSymbolicLink() || linkRoot.uid !== uid || (linkRoot.mode & 0o022) !== 0)
    throw new Error("The provisioner link directory must be owned by this user and not writable by others");
  const socketPath = join(options.directory, DOCKER_PROVISIONER_SOCKET),
    keyPath = join(options.directory, DOCKER_PROVISIONER_KEY);
  if (Buffer.byteLength(socketPath) > 107) throw new Error("Provisioner socket path is too long");
  const answer = await docker.call("GET", "/version");
  if (!ok(answer.status)) throw new Error("The Docker Engine API is unavailable");

  // A fresh request key per provisioner start, readable only by the shared owner identity.
  const key = randomBytes(32).toString("hex");
  const temporary = `${keyPath}.${randomBytes(6).toString("hex")}`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(key + "\n");
  } finally {
    await file.close();
  }
  await rename(temporary, keyPath);

  const seen = new Map<string, number>();
  const remember = (nonce: string, at: number) => {
    const current = now();
    for (const [value, expires] of seen) if (expires < current) seen.delete(value);
    if (seen.has(nonce) || seen.size >= 10_000) return false;
    seen.set(nonce, at + 2 * DOCKER_PROVISIONER_CLOCK_SKEW_MS);
    return true;
  };
  const queues = new Map<string, Promise<unknown>>();
  const serially = <T>(workspace: string, work: () => Promise<T>): Promise<T> => {
    const previous = queues.get(workspace) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(work);
    const tail = next.catch(() => {});
    queues.set(workspace, tail);
    void tail.then(() => {
      if (queues.get(workspace) === tail) queues.delete(workspace);
    });
    return next;
  };

  const containerName = (workspace: string) => `${policy.deployment}-ws-${workspace}`;
  const volumeName = (workspace: string) => `${containerName(workspace)}-data`;
  const ours = (labels: Record<string, string> | undefined, workspace?: string) =>
    labels?.[LABEL.provisioner] === policy.deployment &&
    (workspace === undefined || labels?.[LABEL.workspace] === workspace);
  const inspect = async (workspace: string) => {
    const result = await docker.call("GET", `/containers/${containerName(workspace)}/json`);
    if (result.status === 404) return undefined;
    if (!ok(result.status)) throw dockerFailure("Container inspection", result);
    const labels = result.body?.Config?.Labels as Record<string, string> | undefined;
    // A same-named container that this deployment did not create is never touched.
    if (!ours(labels, workspace)) throw new Refusal("foreign", "The workspace container name belongs to another owner");
    return {
      id: String(result.body?.Id),
      running: result.body?.State?.Running === true,
      image: labels![LABEL.image]!,
    };
  };
  const describe = (container: Awaited<ReturnType<typeof inspect>>): DockerProvisionerContainer =>
    container
      ? { id: container.id, state: container.running ? "running" : "stopped", image: container.image }
      : { state: "absent" };
  const linkDirectoryOf = (workspace: string) => join(policy.linkDirectory, workspace);
  const prepareLink = async (workspace: string, spec: ProvisionedImagePolicy) => {
    const path = linkDirectoryOf(workspace);
    await mkdir(path, { mode: 0o700 }).catch((error) => {
      if (error.code !== "EEXIST") throw error;
    });
    const link = await lstat(path);
    if (!link.isDirectory() || link.isSymbolicLink())
      throw new Refusal("link", "The workspace link directory is not a directory");
    const [owner, group] = spec.user.split(":").map(Number) as [number, number];
    // The agent requires its link directory to be its own and private.
    if (uid === 0 && (link.uid !== owner || link.gid !== group)) await chown(path, owner, group);
    else if (link.uid !== owner)
      throw new Refusal("link", "The workspace agent user must be the provisioner's own user");
    await chmod(path, 0o700);
  };
  const ensureNetwork = async () => {
    if (policy.network === "none") return;
    const existing = await docker.call("GET", `/networks/${policy.network}`);
    if (ok(existing.status)) {
      if (existing.body?.Driver !== "bridge")
        throw new Refusal("network", "The workspace network is not a bridge network");
      return;
    }
    if (existing.status !== 404) throw dockerFailure("Network inspection", existing);
    const created = await docker.call("POST", "/networks/create", {
      Name: policy.network,
      Driver: "bridge",
      Internal: policy.internalNetwork === true,
      Labels: { [LABEL.provisioner]: policy.deployment },
      // Workspaces never reach each other.
      Options: { "com.docker.network.bridge.enable_icc": "false" },
    });
    if (!ok(created.status) && created.status !== 409) throw dockerFailure("Network creation", created);
  };
  const start = async (id: string) => {
    const started = await docker.call("POST", `/containers/${id}/start`);
    if (!ok(started.status) && started.status !== 304) throw dockerFailure("Container start", started);
  };
  const operations: Record<
    DockerProvisionerOperation,
    (workspace: string, image?: string) => Promise<DockerProvisionerContainer>
  > = {
    async inspect(workspace) {
      return describe(await inspect(workspace));
    },
    async ensure(workspace, alias) {
      const spec = alias !== undefined && Object.hasOwn(policy.images, alias) ? policy.images[alias]! : undefined;
      if (!spec) throw new Refusal("image", "The image alias is not allowed");
      const current = await inspect(workspace);
      if (current) {
        // A workspace keeps the image it was created with; changing it is destroy + ensure.
        if (current.image !== alias) throw new Refusal("image-mismatch", "The workspace runs another image alias");
        await prepareLink(workspace, spec);
        if (!current.running) await start(current.id);
        return describe(await inspect(workspace));
      }
      const listed = await docker.call(
        "GET",
        `/containers/json?all=1&filters=${encodeURIComponent(JSON.stringify({ label: [`${LABEL.provisioner}=${policy.deployment}`] }))}`,
      );
      if (!ok(listed.status)) throw dockerFailure("Container listing", listed);
      if (Array.isArray(listed.body) && listed.body.length >= policy.maxWorkspaces)
        throw new Refusal("capacity", "The provisioner's workspace limit is reached");
      const labels = { [LABEL.provisioner]: policy.deployment, [LABEL.workspace]: workspace, [LABEL.image]: alias! };
      await ensureNetwork();
      const volume = await docker.call("POST", "/volumes/create", { Name: volumeName(workspace), Labels: labels });
      if (!ok(volume.status) || !ours(volume.body?.Labels, workspace))
        throw new Refusal("volume", "The workspace volume could not be created or belongs to another owner");
      await prepareLink(workspace, spec);
      const [owner, group] = spec.user.split(":");
      const created = await docker.call("POST", `/containers/create?name=${containerName(workspace)}`, {
        Image: spec.image,
        Entrypoint: [spec.command[0]],
        Cmd: spec.command.slice(1),
        User: spec.user,
        Env: [
          ...Object.entries(spec.env).map(([name, value]) => `${name}=${value}`),
          `OPENCRAFT_AGENT_LINK_DIR=${PROVISIONED_LINK_TARGET}`,
          `OPENCRAFT_AGENT_RUN_DIR=${PROVISIONED_AGENT_RUN}`,
        ],
        Labels: labels,
        WorkingDir: "/",
        NetworkDisabled: policy.network === "none",
        HostConfig: {
          NanoCpus: spec.cpuMillis * 1_000_000,
          Memory: spec.memoryBytes,
          MemorySwap: spec.memoryBytes,
          PidsLimit: spec.pidsLimit,
          Init: true,
          Privileged: false,
          CapDrop: ["ALL"],
          SecurityOpt: ["no-new-privileges:true"],
          NetworkMode: policy.network,
          RestartPolicy: { Name: "unless-stopped" },
          Tmpfs: { [PROVISIONED_AGENT_RUN]: `uid=${owner},gid=${group},mode=0700,size=16m` },
          LogConfig: { Type: "local", Config: { "max-size": "10m", "max-file": "3" } },
          Mounts: [
            { Type: "volume", Source: volumeName(workspace), Target: spec.volumeTarget },
            "volume" in policy.links
              ? {
                  Type: "volume",
                  Source: policy.links.volume,
                  Target: PROVISIONED_LINK_TARGET,
                  VolumeOptions: { NoCopy: true, Subpath: workspace },
                }
              : { Type: "bind", Source: join(policy.links.directory, workspace), Target: PROVISIONED_LINK_TARGET },
            ...(spec.mounts ?? []).map((mount) => ({
              Type: "bind",
              Source: mount.source,
              Target: mount.target,
              ReadOnly: mount.readOnly,
            })),
          ],
        },
      });
      if (created.status === 404)
        throw new Refusal("image-unavailable", "The allowed image is not present on this host");
      if (!ok(created.status)) throw dockerFailure("Container creation", created);
      await start(String(created.body?.Id));
      return describe(await inspect(workspace));
    },
    async stop(workspace) {
      const current = await inspect(workspace);
      if (current?.running) {
        const stopped = await docker.call("POST", `/containers/${current.id}/stop?t=30`);
        if (!ok(stopped.status) && stopped.status !== 304) throw dockerFailure("Container stop", stopped);
      }
      return describe(await inspect(workspace));
    },
    async destroy(workspace) {
      const current = await inspect(workspace);
      if (current) {
        const removed = await docker.call("DELETE", `/containers/${current.id}?force=true`);
        if (!ok(removed.status) && removed.status !== 404) throw dockerFailure("Container removal", removed);
      }
      const volume = await docker.call("GET", `/volumes/${volumeName(workspace)}`);
      if (ok(volume.status)) {
        if (!ours(volume.body?.Labels, workspace))
          throw new Refusal("foreign", "The workspace volume belongs to another owner");
        const removed = await docker.call("DELETE", `/volumes/${volumeName(workspace)}`);
        if (!ok(removed.status) && removed.status !== 404) throw dockerFailure("Volume removal", removed);
      } else if (volume.status !== 404) throw dockerFailure("Volume inspection", volume);
      await rm(linkDirectoryOf(workspace), { recursive: true, force: true });
      return { state: "absent" };
    },
  };

  const parse = (line: string): DockerProvisionerRequest => {
    let value: Record<string, unknown>;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Refusal("malformed", "Request is not JSON");
    }
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Refusal("malformed", "Request is not an object");
    const allowed = ["protocol", "op", "workspace", "image", "nonce", "issuedAt", "mac"];
    if (Object.keys(value).some((key) => !allowed.includes(key)))
      throw new Refusal("malformed", "Request has unknown fields");
    if (value.protocol !== DOCKER_PROVISIONER_PROTOCOL) throw new Refusal("protocol", "Unsupported protocol");
    if (!(DOCKER_PROVISIONER_OPERATIONS as readonly unknown[]).includes(value.op))
      throw new Refusal("malformed", "Unknown operation");
    if (!isWorkspaceId(value.workspace)) throw new Refusal("malformed", "Invalid workspace id");
    if (
      value.op === "ensure"
        ? typeof value.image !== "string" || !DOCKER_PROVISIONER_ALIAS.test(value.image)
        : value.image !== undefined
    )
      throw new Refusal("malformed", "Invalid image alias");
    if (typeof value.nonce !== "string" || !/^[a-f0-9]{32}$/u.test(value.nonce))
      throw new Refusal("malformed", "Invalid nonce");
    if (typeof value.mac !== "string" || !/^[a-f0-9]{64}$/u.test(value.mac))
      throw new Refusal("unauthenticated", "Unsigned request");
    if (!Number.isSafeInteger(value.issuedAt)) throw new Refusal("malformed", "Invalid timestamp");
    return value as unknown as DockerProvisionerRequest;
  };
  // Each operation is named explicitly, so a request can only reach the four
  // handlers above, never another property of the table.
  const dispatch = (op: DockerProvisionerOperation, workspace: string, image?: string) => {
    switch (op) {
      case "ensure":
        return operations.ensure(workspace, image);
      case "inspect":
        return operations.inspect(workspace);
      case "stop":
        return operations.stop(workspace);
      case "destroy":
        return operations.destroy(workspace);
      default:
        throw new Refusal("malformed", "Unknown operation");
    }
  };
  const handle = async (line: string) => {
    const startedAt = now();
    let request: DockerProvisionerRequest | undefined;
    try {
      request = parse(line);
      if (!verifyDockerProvisionerMac(key, request))
        throw new Refusal("unauthenticated", "Request signature is invalid");
      if (Math.abs(now() - request.issuedAt) > DOCKER_PROVISIONER_CLOCK_SKEW_MS)
        throw new Refusal("unauthenticated", "Request is outside the accepted time window");
      if (!remember(request.nonce, request.issuedAt))
        throw new Refusal("unauthenticated", "Request nonce was already used or the replay cache is full");
      const { op, workspace, image } = request;
      const container = await serially(workspace, () => dispatch(op, workspace, image));
      log({
        type: "docker-provisioner-audit",
        op,
        workspace,
        ...(image ? { image } : {}),
        outcome: "ok",
        state: container.state,
        ...(container.id ? { container: container.id.slice(0, 12) } : {}),
        durationMs: now() - startedAt,
      });
      return { protocol: DOCKER_PROVISIONER_PROTOCOL, ok: true, container };
    } catch (error) {
      const refusal =
        error instanceof Refusal ? error : new Refusal("internal", "The provisioner could not complete the request");
      const authenticated =
        refusal.code !== "unauthenticated" && refusal.code !== "malformed" && refusal.code !== "protocol";
      log({
        type: "docker-provisioner-audit",
        ...(request && authenticated
          ? { op: request.op, workspace: request.workspace, ...(request.image ? { image: request.image } : {}) }
          : {}),
        outcome: "refused",
        code: refusal.code,
        reason: refusal.message,
        ...(error instanceof Refusal ? {} : { error: (error as Error)?.message?.slice(0, 200) }),
        durationMs: now() - startedAt,
      });
      return { protocol: DOCKER_PROVISIONER_PROTOCOL, ok: false, code: refusal.code, message: refusal.message };
    }
  };

  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    if (sockets.size >= (options.maxConnections ?? 16)) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.setEncoding("utf8");
    socket.setTimeout(10_000, () => socket.destroy());
    let text = "";
    const data = (chunk: string) => {
      text += chunk;
      const end = text.indexOf("\n");
      if (end < 0) {
        if (text.length > 4096) socket.destroy();
        return;
      }
      socket.off("data", data);
      socket.setTimeout(0);
      void handle(text.slice(0, end)).then((value) => socket.end(JSON.stringify(value) + "\n"));
    };
    socket.on("data", data);
  });
  await rm(socketPath, { force: true });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  await chmod(socketPath, 0o600);
  log({ type: "docker-provisioner-ready", deployment: policy.deployment, images: Object.keys(policy.images) });
  let closing: Promise<void> | undefined;
  return {
    path: socketPath,
    close: () =>
      (closing ??= (async () => {
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
          for (const socket of sockets) socket.destroy();
        });
        await Promise.allSettled([...queues.values()]);
        await rm(socketPath, { force: true });
        await rm(keyPath, { force: true });
      })()),
  };
}
