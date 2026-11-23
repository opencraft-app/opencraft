// `cloudflare` sandbox provider on real Cloudflare Containers: a WorkspaceHost-shaped
// Durable Object that owns one container and drives it only through the provider
// (registry → backend → pool → WorkspaceRuntime). Deployed and driven by
// `npm run cf:rehearsal -- --containers` (scripts/cloudflare/rehearsal-containers.ts);
// the container image runs the real `workspace-agent --bare` as its main process.
// Test-only: no WorkspaceHost assembly, routing or authentication beyond the
// rehearsal guard.
import { DurableObject } from "cloudflare:workers";
import {
  createSandboxPool,
  createWorkspaceRuntime,
  openSandboxEndpoint,
  parseSandboxEnvironmentUri,
  parseWorkspaceEndpointUri,
  probeWorkspaceAgent,
  type Sandbox,
  type SandboxPool,
  type WorkspacePlacementEvent,
  type WorkspacePlacementRecord,
} from "@opencraft/sandbox";
import { createSandboxProviderRegistry } from "@opencraft/sandbox/providers";
import {
  armCloudflareContainerTimeout,
  cloudflareSandboxProvider,
  type CloudflareInstallation,
  type DurableObjectContainer,
} from "@opencraft/sandbox-cloudflare";

const CONTAINER_CLASS = "WorkspaceContainer";
const ENVIRONMENT = parseSandboxEnvironmentUri(`cloudflare://${CONTAINER_CLASS}`);
const PYTHON = "/usr/local/bin/python3";
/** Smallest budget the provider maps (1/4 vCPU, 512 MiB, 2 GB disk): cost control. */
const BUDGET = { cpuMillis: 250, memoryBytes: 512 * 1024 ** 2 };
const INACTIVITY_MS = 5 * 60_000;
const INSTALLATION: CloudflareInstallation = {
  backend: "cloudflare",
  image: "base",
  diskMb: 2000,
  inactivityTimeoutMs: INACTIVITY_MS,
};
const ECHO = String.raw`import os,socket
path='/tmp/oc-echo.sock'
try: os.unlink(path)
except OSError: pass
s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM); s.bind(path); s.listen(4)
print('ready',flush=True)
while True:
    c,_=s.accept()
    while True:
        d=c.recv(65536)
        if not d: break
        c.sendall(d)
    c.shutdown(socket.SHUT_WR); c.close()
`;

interface Env {
  readonly WORKSPACE: { getByName(name: string): { fetch(request: Request): Promise<Response> } };
}
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value, null, 1), { status, headers: { "content-type": "application/json" } });
/** The rehearsal report names a failure by its message and code only; other thrown values stay out of the body. */
const failure = (error: unknown) => {
  if (!(error instanceof Error)) return "Non-error fixture failure";
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" || typeof code === "number" ? `${error.message} (${code})` : error.message;
};
const sha = async (bytes: Uint8Array) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
const random = (size: number) => {
  const bytes = new Uint8Array(size);
  for (let at = 0; at < size; at += 65536) crypto.getRandomValues(bytes.subarray(at, Math.min(size, at + 65536)));
  return bytes;
};
const concat = (chunks: Uint8Array[]) => {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
};
const until = async (check: () => boolean, ms: number) => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw Error("condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};
/** Runs one command to completion through the sandbox and collects its output. */
async function run(
  sandbox: Sandbox,
  command: string[],
  options: { env?: Record<string, string>; terminal?: { cols: number; rows: number } } = {},
) {
  const chunks: Uint8Array[] = [];
  const started = Date.now();
  const process = await sandbox.spawn(
    { command, cwd: "/", env: options.env ?? {}, ...(options.terminal ? { terminal: options.terminal } : {}) },
    (output) => chunks.push(output.data),
  );
  const spawnMs = Date.now() - started;
  const exit = await process.exited;
  return { spawnMs, exit, text: new TextDecoder().decode(concat(chunks)) };
}

export class WorkspaceContainer extends DurableObject<Env> {
  readonly #container: DurableObjectContainer;
  #pool: Promise<SandboxPool> | undefined;
  #sandbox: Sandbox | undefined;
  readonly #constructed = Date.now();

  constructor(ctx: any, env: Env) {
    super(ctx, env);
    this.#container = ctx.container as DurableObjectContainer;
    // The inactivity backstop is not retained across Durable Object restarts.
    void ctx.blockConcurrencyWhile(() => armCloudflareContainerTimeout(this.#container, INACTIVITY_MS).catch(() => {}));
  }

  #registry() {
    return createSandboxProviderRegistry<CloudflareInstallation>({
      cloudflare: cloudflareSandboxProvider({
        containerClass: CONTAINER_CLASS,
        container: this.#container,
        waitUntil: (promise) => this.ctx.waitUntil(promise),
      }),
    });
  }
  #newPool(id: string) {
    const { definition, templateId } = this.#registry().environment(INSTALLATION, ENVIRONMENT);
    const backend = definition.createBackend({
      installation: INSTALLATION,
      readSecret: async () => "",
      templateId,
      python: PYTHON,
      timeoutMs: 600_000,
      requestTimeoutMs: 60_000,
    });
    return createSandboxPool({ id, capacity: BUDGET, defaults: BUDGET }, backend);
  }
  #store() {
    return {
      read: async () => (await this.ctx.storage.get("placement")) as WorkspacePlacementRecord | undefined,
      write: async (_address: unknown, record: WorkspacePlacementRecord) => {
        await this.ctx.storage.put("placement", record);
      },
    };
  }

  async fetch(request: Request): Promise<Response> {
    const action = new URL(request.url).pathname.split("/").pop();
    const report: Record<string, unknown> = { action, constructedAt: this.#constructed };
    try {
      if (action === "status") {
        report.running = this.#container.running;
        report.inspect = await this.#container.inspect();
        return json(report);
      }
      if (action === "create") return json(await this.#create(report));
      if (action === "reset") {
        // A Durable Object reset: the in-memory pool, sandbox and exec handles are gone.
        this.ctx.abort("rehearsal reset");
        return json(report);
      }
      if (action === "attach") return json(await this.#attach(report));
      if (action === "destroy") {
        // Rehearsal cleanup: stop whatever container this object holds.
        if (this.#container.running) await this.#container.destroy();
        report.running = this.#container.running;
        return json(report);
      }
      if (action === "close") {
        const started = Date.now();
        await this.#sandbox?.close();
        report.closeMs = Date.now() - started;
        report.running = this.#container.running;
        return json(report);
      }
      return json({ error: "unknown action" }, 404);
    } catch (error) {
      report.error = failure(error);
      return json(report, 500);
    }
  }

  /** create → spawn (env, exit code, PTY) → endpoint round trip → agent identity. */
  async #create(report: Record<string, unknown>) {
    this.#pool ??= this.#newPool("rehearsal");
    const pool = await this.#pool;
    let started = Date.now();
    const sandbox = (this.#sandbox = await pool.createSandbox({ owner: "cf-rehearsal" }));
    report.createMs = Date.now() - started;
    report.receipt = sandbox.receipt;
    report.resources = sandbox.resources;
    report.inspect = await this.#container.inspect();
    // exec does not inherit the start environment; argv/env/exit code round-trip literally.
    report.command = await run(
      sandbox,
      ["/bin/sh", "-c", 'printf "%s|%s|%s" "$OPENCRAFT_DATA_DIR" "$OC_COMMAND" "$1"; exit 3', "sh", "arg with space"],
      {
        env: { OC_COMMAND: "command" },
      },
    );
    report.terminal = await run(sandbox, ["/bin/sh", "-c", "stty size; tty"], { terminal: { cols: 123, rows: 45 } });
    // A non-attached server plus an attached relay to it: 4 MiB binary round trip.
    let ready = "";
    const server = await sandbox.spawn({ command: [PYTHON, "-I", "-u", "-c", ECHO], cwd: "/", env: {} }, (output) => {
      ready += new TextDecoder().decode(output.data);
    });
    await until(() => ready.includes("ready"), 20_000);
    const payload = random(4 * 1024 * 1024),
      chunks: Uint8Array[] = [];
    let received = 0;
    started = Date.now();
    const connection = await openSandboxEndpoint(sandbox, {
      target: { unix: "/tmp/oc-echo.sock" },
      python: PYTHON,
      onData: (data) => {
        chunks.push(data);
        received += data.byteLength;
      },
    });
    const openMs = Date.now() - started;
    started = Date.now();
    for (let at = 0; at < payload.byteLength; at += 65536) await connection.write(payload.subarray(at, at + 65536));
    await connection.end();
    const end = await connection.closed;
    report.endpoint = {
      openMs,
      roundTripMs: Date.now() - started,
      bytes: received,
      equal: (await sha(concat(chunks))) === (await sha(payload)),
      end,
    };
    await connection.close();
    await server.terminate();
    report.serverExit = await server.exited.catch(failure);
    // The real workspace-agent is the container's main process.
    const agent = await probeWorkspaceAgent(sandbox, { python: PYTHON });
    report.agent = { incarnation: agent.incarnation.id, endpoints: agent.endpoints, state: agent.state };
    await this.ctx.storage.put("placement", {
      ...(sandbox.receipt ? { receipt: sandbox.receipt } : {}),
      agentIncarnation: agent.incarnation.id,
    } satisfies WorkspacePlacementRecord);
    return report;
  }

  /** After a reset: WorkspaceRuntime re-attaches by receipt; the agent stopping is a
   * provider-reported loss; the next use creates a new incarnation; close destroys it. */
  async #attach(report: Record<string, unknown>) {
    report.runningAtConstruction = this.#container.running;
    const events: (WorkspacePlacementEvent & { at: number })[] = [];
    const t0 = Date.now();
    this.#pool ??= this.#newPool("rehearsal-attach");
    const pool = await this.#pool;
    const runtime = createWorkspaceRuntime({
      workspaceId: "default",
      owner: "cf-rehearsal",
      environments: [{ address: ENVIRONMENT, pool, python: PYTHON }],
      store: this.#store(),
      onEvent: (event) => events.push({ ...event, at: Date.now() - t0 }),
    });
    const before = (await this.#store().read())?.agentIncarnation;
    report.observed = await runtime.observe();
    report.sameIncarnation = (report.observed as { incarnation: string }[])[0]?.incarnation === before;
    // A control round trip through the runtime's endpoint path (workspace:// URI).
    let answer = "";
    const control = await runtime.connect(
      parseWorkspaceEndpointUri("workspace://default/endpoints/control"),
      (data) => {
        answer += new TextDecoder().decode(data);
      },
    );
    await control.write(new TextEncoder().encode(JSON.stringify({ type: "probe", protocol: 1 }) + "\n"));
    await until(() => answer.includes("\n"), 20_000);
    await control.close();
    report.controlAnswer = JSON.parse(answer.split("\n")[0]!).incarnation?.id === before;
    // A second handle on the same instance (receipt attach) stops the agent: the container
    // exits by itself and the provider reports the loss (monitor) to the runtime.
    const receipt = (await this.#store().read())!.receipt!;
    const side = await this.#newPool("rehearsal-side");
    const handle = await side.attachSandbox({ owner: "cf-rehearsal", receipt });
    const stopAt = Date.now();
    await handle.spawn({ command: ["/bin/kill", "-TERM", "1"], cwd: "/", env: {} });
    report.loss = await handle.lost;
    report.lossMs = Date.now() - stopAt;
    await until(() => events.some((event) => event.type === "released"), 30_000);
    await handle.close();
    await side.close();
    report.runningAfterLoss = this.#container.running;
    // Next use: the receipt no longer binds (stopped), so a new incarnation is created.
    const recreatedAt = Date.now();
    report.reobserved = await runtime.observe();
    report.recreateMs = Date.now() - recreatedAt;
    report.newReceipt = (await this.#store().read())?.receipt;
    const closeAt = Date.now();
    await runtime.close();
    report.closeMs = Date.now() - closeAt;
    report.runningAfterClose = this.#container.running;
    report.inspectAfterClose = await this.#container.inspect();
    report.events = events;
    await pool.close();
    this.#pool = undefined;
    return report;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const match = new URL(request.url).pathname.match(/^\/do\/([a-z0-9-]{1,32})\/[a-z]+$/u);
    if (!match) return new Response("Not found", { status: 404 });
    return env.WORKSPACE.getByName(match[1]!).fetch(request);
  },
};
