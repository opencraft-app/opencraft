/** SandboxBackend harnesses for the endpoint/attached conformance suite and its
 * measurement script. Every harness exposes the same shape: a backend, the
 * interpreter path inside its environments, and a way to host a stream-socket
 * target that environments can reach by path. A new provider adds a harness here
 * and must pass tests/execution/sandbox-endpoint-conformance.test.ts unchanged. */
import { spawn, execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import {
  SandboxFault,
  type SandboxBackend,
  type SandboxCommand,
  type SandboxEnvironment,
  type SandboxExit,
  type SandboxOutput,
  type SandboxProcess,
} from "@opencraft/sandbox";
import { brokerSource, startBrokerProcess } from "@opencraft/sandbox/broker";
import { SandboxNotFoundError } from "e2b";
import { e2bSandboxBackend, type E2BConnection } from "../../../packages/sandbox-e2b/src/index";
import { serveSandboxLink, staticDockerSandboxBackend } from "@opencraft/sandbox-node/static-docker";
import { mkdir } from "node:fs/promises";
import { dockerProvisionerClient, dockerProvisionerSandboxBackend } from "@opencraft/sandbox-node/docker-provisioner";
import {
  dockerEngine,
  parseDockerProvisionerPolicy,
  serveDockerProvisioner,
} from "@opencraft/sandbox-node/docker-provisioner-service";
import { cloudflareSandboxBackend } from "@opencraft/sandbox-cloudflare";
import { FakeDurableObjectContainer } from "./cloudflare-container";

/** Observe the commands a backend receives without changing its behaviour. */
function recording(backend: SandboxBackend, commands: SandboxCommand[]): SandboxBackend {
  const wrap = (environment: SandboxEnvironment): SandboxEnvironment => ({
    ...(environment.receipt ? { receipt: environment.receipt } : {}),
    resources: environment.resources,
    capabilities: environment.capabilities,
    ...(environment.processLimits ? { processLimits: environment.processLimits } : {}),
    spawn(command, onOutput) {
      commands.push(command);
      return environment.spawn(command, onOutput);
    },
    close: () => environment.close(),
  });
  return {
    id: backend.id,
    initialize: (policy, signal) => backend.initialize(policy, signal),
    close: () => backend.close(),
    async create(identity, resources, signal) {
      return wrap(await backend.create(identity, resources, signal));
    },
    ...(backend.attach
      ? {
          async attach(identity: any, receipt: any, resources: any, signal: AbortSignal) {
            return wrap(await backend.attach!(identity, receipt, resources, signal));
          },
        }
      : {}),
  };
}

export interface EndpointHarness {
  readonly name: string;
  readonly backend: SandboxBackend;
  /** Interpreter path inside the environment. */
  readonly python: string;
  /** Effective resources the backend reports (pool capacity/defaults). */
  readonly resources: { cpuMillis: number; memoryBytes: number };
  /** A long-running non-attached pipe process (reads stdin, echoes it). */
  readonly catCommand: readonly string[];
  /** Listen on a stream socket reachable from environments; returns its in-environment path.
   * `fileName` places it under that exact name (named-endpoint checks). */
  listen(handler: (socket: Socket) => void, fileName?: string): Promise<string>;
  /** A path where nothing listens. */
  missing(): string;
  /** Commands the backend has received, in order. */
  readonly commands: SandboxCommand[];
  /** Environment closes the backend performed (any reason). */
  readonly closes: { count: number };
  /** Commands as the guest received them, for broker-based harnesses. */
  readonly wire?: SandboxCommand[];
  /** Attach-capable providers: a fresh backend over the same instances (a restarted Host). */
  reconnect?(): SandboxBackend;
  /** Attach-capable providers: replace or lose the current instance (new incarnation). */
  replaceInstance?(): Promise<void>;
  dispose(): Promise<void>;
}

const defaults = { cpuMillis: 4000, memoryBytes: 8 * 1024 ** 3 };

async function socketHost(mount?: { host: string; guest: string }) {
  const directory = mount?.host ?? (await mkdtemp(join(tmpdir(), "oc-ep-")));
  const servers: Server[] = [],
    sockets = new Set<Socket>();
  return {
    directory,
    async listen(handler: (socket: Socket) => void, fileName?: string) {
      const name = fileName ?? randomUUID().slice(0, 8) + ".sock",
        path = join(directory, name);
      const server = createServer({ allowHalfOpen: true }, (socket) => {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
        handler(socket);
      });
      servers.push(server);
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(path, () => resolve());
      });
      return mount ? mount.guest + "/" + name : path;
    },
    missing: () => (mount ? mount.guest : directory) + "/missing.sock",
    async dispose() {
      for (const socket of sockets) socket.destroy();
      await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
      if (!mount) await rm(directory, { recursive: true, force: true });
    },
  };
}

/** In-process backend: implements the relay's semantics with Node sockets and no
 * guest interpreter. It models a backend whose processes never need environment
 * retirement (e.g. a supervised local owner). */
export async function inProcessHarness(): Promise<EndpointHarness> {
  const host = await socketHost(),
    commands: SandboxCommand[] = [],
    closes = { count: 0 };
  const environment = (): SandboxEnvironment => {
    let ended = false;
    const live = new Set<() => void>();
    return {
      resources: defaults,
      capabilities: { terminal: false },
      async spawn(command, onOutput) {
        if (ended) throw new SandboxFault("SANDBOX_CLOSED", "closed");
        commands.push(command);
        let resolveExit!: (exit: SandboxExit) => void;
        const exited = new Promise<SandboxExit>((resolve) => {
          resolveExit = resolve;
        });
        let done = false;
        const finish = (code: number | null) => {
          if (!done) {
            done = true;
            live.delete(kill);
            resolveExit({ code });
          }
        };
        const kill = () => {
          socket?.destroy();
          finish(null);
        };
        live.add(kill);
        let socket: Socket | undefined;
        if (command.command.includes("-c") && command.command.at(-2)?.startsWith("import os,select,socket")) {
          socket = createConnection({ path: command.command.at(-1)!, allowHalfOpen: true });
          socket.on("data", (data: Buffer) => onOutput?.({ stream: "stdout", data: new Uint8Array(data) }));
          socket.on("end", () => {
            socket!.destroy();
            finish(0);
          });
          socket.on("error", () => finish(1));
          await once(socket, "connect").catch(() => {});
        }
        const process: SandboxProcess = {
          id: randomUUID(),
          kind: "process",
          exited,
          async writeStdin(data) {
            if (done) throw new SandboxFault("SANDBOX_CLOSED", "closed");
            if (socket)
              await new Promise<void>((resolve, reject) =>
                socket!.write(data, (error) => (error ? reject(error) : resolve())),
              );
            else onOutput?.({ stream: "stdout", data });
          },
          async closeStdin() {
            if (!done) socket?.end();
          },
          async terminate() {
            kill();
          },
        };
        return process;
      },
      async close() {
        if (!ended) {
          ended = true;
          closes.count++;
          for (const kill of [...live]) kill();
        }
      },
    };
  };
  return {
    name: "in-process",
    python: "/usr/bin/python3",
    resources: defaults,
    catCommand: ["cat"],
    commands,
    closes,
    backend: {
      id: "in-process",
      async initialize() {},
      async create() {
        return environment();
      },
      async close() {},
    },
    listen: host.listen,
    missing: host.missing,
    dispose: host.dispose,
  };
}

function childProcess(
  child: ChildProcessWithoutNullStreams,
  onOutput?: (output: SandboxOutput) => void,
): SandboxProcess {
  const exited = new Promise<SandboxExit>((resolve) =>
    child.once("close", (code, signal) => resolve({ code, ...(signal ? { signal } : {}) })),
  );
  child.stdout.on("data", (data: Buffer) => onOutput?.({ stream: "stdout", data: new Uint8Array(data) }));
  child.stderr.on("data", (data: Buffer) => onOutput?.({ stream: "stderr", data: new Uint8Array(data) }));
  child.stdin.on("error", () => {});
  return {
    id: randomUUID(),
    kind: "process",
    exited,
    writeStdin: (data) =>
      new Promise<void>((resolve, reject) => child.stdin.write(data, (error) => (error ? reject(error) : resolve()))),
    async closeStdin() {
      child.stdin.end();
    },
    async terminate() {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await exited;
      }
    },
  };
}

/** Local child processes without the broker (a Hands-style local owner). */
export async function localProcessHarness(): Promise<EndpointHarness> {
  const host = await socketHost(),
    commands: SandboxCommand[] = [],
    closes = { count: 0 };
  return {
    name: "local-process",
    python: "/usr/bin/python3",
    resources: defaults,
    catCommand: ["/bin/cat"],
    commands,
    closes,
    backend: {
      id: "local-process",
      async initialize() {},
      async close() {},
      async create() {
        const children = new Set<ChildProcessWithoutNullStreams>();
        let ended = false;
        return {
          resources: defaults,
          capabilities: { terminal: false },
          async spawn(command, onOutput) {
            if (ended) throw new SandboxFault("SANDBOX_CLOSED", "closed");
            commands.push(command);
            const child = spawn(command.command[0]!, command.command.slice(1), {
              cwd: command.cwd,
              env: command.env,
              stdio: ["pipe", "pipe", "pipe"],
            });
            children.add(child);
            child.once("close", () => children.delete(child));
            await once(child, "spawn");
            return childProcess(child, onOutput);
          },
          async close() {
            if (ended) return;
            ended = true;
            closes.count++;
            await Promise.all(
              [...children].map(async (child) => {
                child.kill("SIGKILL");
                await once(child, "close").catch(() => {});
              }),
            );
          },
        };
      },
    },
    listen: host.listen,
    missing: host.missing,
    dispose: host.dispose,
  };
}

/** Real E2B adapter and shared broker; only the vendor SDK is replaced by local processes. */
export async function e2bFixtureHarness(): Promise<EndpointHarness> {
  const host = await socketHost(),
    commands: SandboxCommand[] = [],
    closes = { count: 0 };
  const wire: SandboxCommand[] = [];
  const directory = await mkdtemp(join(tmpdir(), "oc-e2b-")),
    children = new Set<ChildProcessWithoutNullStreams>();
  const instances = new Map<string, ReturnType<typeof instance>>();
  const instance = () => {
    let gone = false;
    const owned = new Set<ChildProcessWithoutNullStreams>();
    return {
      sandboxId: "endpoint-conformance-" + randomUUID(),
      get gone() {
        return gone;
      },
      async getInfo() {
        if (gone) throw new SandboxNotFoundError("gone");
        return { cpuCount: 4, memoryMB: 8192 };
      },
      async kill() {
        if (!gone) {
          gone = true;
          closes.count++;
        }
        for (const child of owned) child.kill("SIGKILL");
      },
      async setTimeout() {},
      files: {
        async write(path: string, data: string) {
          await writeFile(join(directory, basename(path)), data);
        },
      },
      commands: {
        async run(command: string, options: any) {
          const child = spawn(
            "/bin/sh",
            ["-c", command.replace(/\/tmp\/opencraft-exec-/g, directory + "/opencraft-exec-")],
            { stdio: ["pipe", "pipe", "pipe"] },
          );
          children.add(child);
          owned.add(child);
          const done = once(child, "close");
          void done.then(() => {
            children.delete(child);
            owned.delete(child);
          });
          child.stdin.on("error", () => {});
          child.stdout.on("data", (data) => options.onStdout(data.toString("ascii")));
          child.stderr.on("data", (data) => options.onStderr(data.toString("utf8")));
          return {
            sendStdin: (data: string) => {
              for (const line of data.split("\n"))
                if (line.startsWith('{"type":"start"')) wire.push(JSON.parse(line).command);
              return new Promise<void>((resolve, reject) =>
                child.stdin.write(data, (error) => (error ? reject(error) : resolve())),
              );
            },
            wait: async () => {
              const [code] = await done;
              if (code !== 0) throw Error("transport stopped");
              return { exitCode: code };
            },
          };
        },
      },
    };
  };
  let latest: ReturnType<typeof instance> | undefined;
  const driver = {
    async create() {
      const value = instance();
      instances.set(value.sandboxId, value);
      latest = value;
      return value;
    },
    async connect(sandboxId: string) {
      const value = instances.get(sandboxId);
      if (!value || value.gone) throw new SandboxNotFoundError("gone");
      return value;
    },
  } as unknown as E2BConnection;
  const options = {
    apiUrl: "https://api.example.test",
    sandboxUrl: "https://proxy.example.test",
    templateId: "endpoint-conformance",
    readApiKey: async () => "synthetic",
  };
  return {
    name: "e2b-fixture",
    python: "/usr/bin/python3",
    resources: defaults,
    catCommand: ["/bin/cat"],
    commands,
    closes,
    backend: recording(e2bSandboxBackend(options, driver), commands),
    wire,
    reconnect: () => recording(e2bSandboxBackend(options, driver), commands),
    // E2B: the instance is gone (killed outside this Host); its receipt must not re-attach.
    async replaceInstance() {
      await latest?.kill();
    },
    listen: host.listen,
    missing: host.missing,
    async dispose() {
      for (const child of children) child.kill("SIGKILL");
      await host.dispose();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

/** static-docker with the agent's link server in this process (the channel without
 * a container): real link protocol, ticket, sessions and the shared broker. */
export async function staticDockerLinkHarness(): Promise<EndpointHarness> {
  const host = await socketHost(),
    commands: SandboxCommand[] = [],
    closes = { count: 0 };
  const directory = await mkdtemp(join(tmpdir(), "oc-link-"));
  const link = join(directory, "brain");
  await mkdir(link, { mode: 0o700 });
  const start = () =>
    serveSandboxLink({
      directory: link,
      python: "/usr/bin/python3",
      policy: "any",
      endpointDirectory: host.directory,
      incarnation: { id: randomUUID().replaceAll("-", ""), evidence: "test", startedAt: new Date().toISOString() },
      limits: async () => ({ cpuMillis: defaults.cpuMillis, memoryBytes: defaults.memoryBytes, tasks: 4096 }),
    });
  let server = await start();
  const counted = (backend: SandboxBackend): SandboxBackend => {
    const count = (environment: SandboxEnvironment): SandboxEnvironment => ({
      ...environment,
      spawn: environment.spawn,
      close: async () => {
        await environment.close();
        closes.count++;
      },
    });
    return {
      ...backend,
      create: async (...args) => count(await backend.create(...args)),
      attach: async (...args) => count(await backend.attach!(...args)),
    };
  };
  const make = () => recording(counted(staticDockerSandboxBackend({ directory: link })), commands);
  return {
    name: "static-docker-link",
    python: "/usr/bin/python3",
    resources: defaults,
    catCommand: ["/bin/cat"],
    commands,
    closes,
    backend: make(),
    reconnect: make,
    async replaceInstance() {
      await server.close();
      server = await start();
    },
    listen: host.listen,
    missing: host.missing,
    async dispose() {
      await server.close();
      await host.dispose();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

/** The real `cloudflare` backend and shared broker in a Durable Object whose
 * `ctx.container` is the in-process double (fixtures/cloudflare-container.ts): exec
 * streams with back-pressure, start env not inherited, single-process kill, labels,
 * monitor, destroy. A Host restart is a Durable Object reset over the same container. */
export async function cloudflareFixtureHarness(): Promise<EndpointHarness> {
  const host = await socketHost(),
    commands: SandboxCommand[] = [],
    wire: SandboxCommand[] = [];
  const container = new FakeDurableObjectContainer();
  // Every environment teardown is a container destroy (owner close or fail-closed retirement).
  const closes = {
    get count() {
      return container.destroys;
    },
  };
  let partial = "";
  const decoder = new TextDecoder();
  container.onStdin = (chunk) => {
    partial += decoder.decode(chunk, { stream: true });
    for (let at = partial.indexOf("\n"); at >= 0; at = partial.indexOf("\n")) {
      const line = partial.slice(0, at);
      partial = partial.slice(at + 1);
      if (line.startsWith('{"type":"start"')) wire.push(JSON.parse(line).command);
    }
  };
  const make = () =>
    recording(
      cloudflareSandboxBackend({
        container,
        image: container.images.base,
        python: "/usr/bin/python3",
        requestTimeoutMs: 15_000,
        inactivityTimeoutMs: 15 * 60_000,
      }),
      commands,
    );
  return {
    name: "cloudflare-fixture",
    python: "/usr/bin/python3",
    resources: defaults,
    catCommand: ["/bin/cat"],
    commands,
    closes: closes as { count: number },
    wire,
    backend: make(),
    reconnect: () => {
      container.resetDurableObject();
      return make();
    },
    // The platform restarted the container: same Durable Object, new incarnation.
    replaceInstance: () => container.restart(),
    listen: host.listen,
    missing: host.missing,
    async dispose() {
      await container.destroy().catch(() => {});
      await host.dispose();
      if (container.killAfterExit) throw Error(`signalled ${container.killAfterExit} exited process(es)`);
    },
  };
}

const run = promisify(execFile);
/** A real local container reached through `docker exec -i` and the shared broker
 * (the per-process stream a docker-provisioner/static-docker provider would use).
 * Opt-in: OPENCRAFT_SANDBOX_CONFORMANCE_DOCKER=<image with python3>. */
export async function dockerHarness(image: string): Promise<EndpointHarness> {
  const mountDirectory = await mkdtemp(join(tmpdir(), "oc-docker-"));
  const host = await socketHost({ host: mountDirectory, guest: "/endpoint" });
  const commands: SandboxCommand[] = [],
    closes = { count: 0 };
  const python = (
    await run("docker", ["run", "--rm", "--entrypoint", "sh", image, "-c", "command -v python3"])
  ).stdout.trim();
  const containers = new Set<string>();
  return {
    name: "docker-exec",
    python,
    resources: defaults,
    catCommand: ["cat"],
    commands,
    closes,
    backend: {
      id: "docker-exec",
      async initialize() {},
      async close() {},
      async create() {
        const id = (
          await run("docker", [
            "run",
            "-d",
            "--rm",
            "--cpus",
            "4",
            "--memory",
            "8g",
            "-v",
            mountDirectory + ":/endpoint",
            "--entrypoint",
            "sleep",
            image,
            "infinity",
          ])
        ).stdout.trim();
        containers.add(id);
        let ended = false;
        const environment: SandboxEnvironment = {
          resources: defaults,
          capabilities: { terminal: true },
          async spawn(command, onOutput) {
            if (ended) throw new SandboxFault("SANDBOX_CLOSED", "closed");
            commands.push(command);
            return startBrokerProcess({
              id: randomUUID(),
              command,
              onOutput,
              requestTimeoutMs: 15000,
              label: "Docker",
              closeEnvironment: () => environment.close(),
              async launch(onStdout) {
                const child = spawn("docker", ["exec", "-i", id, python, "-u", "-c", brokerSource], {
                  stdio: ["pipe", "pipe", "ignore"],
                });
                child.stdin.on("error", () => {});
                child.stdout.setEncoding("ascii").on("data", onStdout);
                await once(child, "spawn");
                return {
                  ended: once(child, "close"),
                  write: (frame) =>
                    new Promise<void>((resolve, reject) =>
                      child.stdin.write(frame, (error) => (error ? reject(error) : resolve())),
                    ),
                };
              },
            });
          },
          async close() {
            if (ended) return;
            ended = true;
            closes.count++;
            containers.delete(id);
            await run("docker", ["rm", "-f", id]);
          },
        };
        return environment;
      },
    },
    listen: host.listen,
    missing: host.missing,
    async dispose() {
      for (const id of containers) await run("docker", ["rm", "-f", id]).catch(() => {});
      await host.dispose();
      await rm(mountDirectory, { recursive: true, force: true });
    },
  };
}

/** static-docker against a real container: the opencraft runtime image runs its
 * `workspace-agent --bare` as the container's main process (Docker applies the
 * budget), serving the link in a host directory mounted only into that container.
 * This process holds no Docker socket for the link: `docker` is used only to start
 * and replace the container. Opt-in: OPENCRAFT_SANDBOX_CONFORMANCE_STATIC_DOCKER=<image>. */
export async function staticDockerContainerHarness(image: string): Promise<EndpointHarness> {
  const directory = await mkdtemp(join(tmpdir(), "oc-sd-"));
  const link = join(directory, "link"),
    endpoints = join(directory, "endpoints");
  await mkdir(link, { mode: 0o700 });
  await mkdir(endpoints, { mode: 0o700 });
  const host = await socketHost({ host: endpoints, guest: "/endpoint" });
  const commands: SandboxCommand[] = [],
    closes = { count: 0 };
  let container = "";
  const start = async () => {
    container = (
      await run("docker", [
        "run",
        "-d",
        "--rm",
        "--init",
        "--user",
        "0:0",
        "--network",
        "none",
        "--cpus",
        "4",
        "--memory",
        "8g",
        "--tmpfs",
        "/run/opencraft-agent:mode=0700",
        "-v",
        `${link}:/run/opencraft-link`,
        "-v",
        `${endpoints}:/endpoint`,
        "-e",
        "OPENCRAFT_DATA_DIR=/var/tmp/oc-data",
        "-e",
        "OPENCRAFT_WORKSPACE_DIR=/var/tmp/oc-workspace",
        "-e",
        "OPENCRAFT_AGENT_LINK_DIR=/run/opencraft-link",
        "-e",
        "OPENCRAFT_AGENT_LINK_POLICY=any",
        "--entrypoint",
        "/opt/opencraft/bin/node",
        image,
        "/opt/opencraft/runtime/workspace-agent.mjs",
        "--bare",
      ])
    ).stdout.trim();
    const deadline = Date.now() + 60_000;
    for (;;) {
      try {
        await readFile(join(link, "ticket"));
        await readFile(join(link, "link.sock")).catch((error) => {
          if (error.code !== "ENXIO" && error.code !== "EOPNOTSUPP") throw error;
        });
        return;
      } catch {
        if (Date.now() > deadline) throw Error("static-docker agent did not start");
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
  };
  await start();
  const counted = (backend: SandboxBackend): SandboxBackend => {
    const count = (environment: SandboxEnvironment): SandboxEnvironment => ({
      ...environment,
      spawn: environment.spawn,
      close: async () => {
        await environment.close();
        closes.count++;
      },
    });
    return {
      ...backend,
      create: async (...args) => count(await backend.create(...args)),
      attach: async (...args) => count(await backend.attach!(...args)),
    };
  };
  const make = () => recording(counted(staticDockerSandboxBackend({ directory: link })), commands);
  return {
    name: "static-docker-container",
    python: "/usr/bin/python3",
    resources: defaults,
    catCommand: ["/bin/cat"],
    commands,
    closes,
    backend: make(),
    reconnect: make,
    // A container restart: same declared service, new agent incarnation.
    async replaceInstance() {
      await run("docker", ["rm", "-f", container]);
      await rm(join(link, "ticket"), { force: true });
      await start();
    },
    listen: host.listen,
    missing: host.missing,
    async dispose() {
      await run("docker", ["rm", "-f", container]).catch(() => {});
      await host.dispose();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

/** docker-provisioner against real containers: the provisioner service runs in this
 * process with the Docker socket (as the Compose `provisioner` service does) and creates
 * the workspace container from its own policy (the opencraft image's `workspace-agent
 * --bare` with the `any` link policy, `--network none`). The backend under test holds no
 * Docker socket: it speaks the signed provisioner protocol and reaches the container only
 * through the agent's link. Opt-in: OPENCRAFT_SANDBOX_CONFORMANCE_DOCKER_PROVISIONER=<image>. */
export async function dockerProvisionerContainerHarness(image: string): Promise<EndpointHarness> {
  const directory = await mkdtemp(join(tmpdir(), "oc-dp-"));
  const control = join(directory, "control"),
    links = join(directory, "links"),
    endpoints = join(directory, "endpoints");
  for (const path of [control, links, endpoints]) await mkdir(path, { mode: 0o700 });
  const host = await socketHost({ host: endpoints, guest: "/endpoint" });
  const commands: SandboxCommand[] = [],
    closes = { count: 0 };
  const workspace = "conformance-" + randomUUID().slice(0, 8);
  const service = await serveDockerProvisioner({
    directory: control,
    docker: dockerEngine("/var/run/docker.sock"),
    log: () => {},
    policy: parseDockerProvisionerPolicy({
      deployment: "oc-conformance",
      maxWorkspaces: 4,
      network: "none",
      links: { directory: links },
      linkDirectory: links,
      images: {
        bare: {
          image,
          command: ["/opt/opencraft/bin/node", "/opt/opencraft/runtime/workspace-agent.mjs", "--bare"],
          // This test process (the Host) runs as root: the link must be its identity.
          user: "0:0",
          root: true,
          cpuMillis: defaults.cpuMillis,
          memoryBytes: defaults.memoryBytes,
          pidsLimit: 4096,
          volumeTarget: "/var/lib/opencraft-workspace",
          env: {
            OPENCRAFT_DATA_DIR: "/var/lib/opencraft-workspace/data",
            OPENCRAFT_WORKSPACE_DIR: "/var/lib/opencraft-workspace/workspace",
            OPENCRAFT_AGENT_LINK_POLICY: "any",
          },
          // Operator-declared (policy, never request) mount for the suite's socket targets.
          mounts: [{ source: endpoints, target: "/endpoint", readOnly: false }],
        },
      },
    }),
  });
  const client = dockerProvisionerClient({ directory: control });
  const counted = (backend: SandboxBackend): SandboxBackend => {
    const count = (environment: SandboxEnvironment): SandboxEnvironment => ({
      ...environment,
      spawn: environment.spawn,
      close: async () => {
        await environment.close();
        closes.count++;
      },
    });
    return {
      ...backend,
      create: async (...args) => count(await backend.create(...args)),
      attach: async (...args) => count(await backend.attach!(...args)),
    };
  };
  const make = () =>
    recording(
      counted(
        dockerProvisionerSandboxBackend({
          directory: control,
          linkRoot: links,
          image: "bare",
          workspaceId: async () => workspace,
        }),
      ),
      commands,
    );
  return {
    name: "docker-provisioner",
    python: "/usr/bin/python3",
    resources: defaults,
    catCommand: ["/bin/cat"],
    commands,
    closes,
    backend: make(),
    reconnect: make,
    // The workspace container is destroyed and provisioned again: new container, new incarnation.
    async replaceInstance() {
      await client.request("destroy", workspace);
      await client.request("ensure", workspace, "bare");
    },
    listen: host.listen,
    missing: host.missing,
    async dispose() {
      await client.request("destroy", workspace).catch(() => {});
      await service.close();
      await host.dispose();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

export async function harnesses(): Promise<(() => Promise<EndpointHarness>)[]> {
  const only = process.env.OPENCRAFT_SANDBOX_CONFORMANCE_ONLY;
  const list = [
    inProcessHarness,
    localProcessHarness,
    e2bFixtureHarness,
    staticDockerLinkHarness,
    cloudflareFixtureHarness,
  ].filter(
    (make) => !only || make.name.toLowerCase().startsWith(only),
  );
  const image = process.env.OPENCRAFT_SANDBOX_CONFORMANCE_DOCKER,
    workspaceImage = process.env.OPENCRAFT_SANDBOX_CONFORMANCE_STATIC_DOCKER,
    provisionedImage = process.env.OPENCRAFT_SANDBOX_CONFORMANCE_DOCKER_PROVISIONER;
  return [
    ...list,
    ...(image ? [() => dockerHarness(image)] : []),
    ...(workspaceImage ? [() => staticDockerContainerHarness(workspaceImage)] : []),
    ...(provisionedImage ? [() => dockerProvisionerContainerHarness(provisionedImage)] : []),
  ];
}
