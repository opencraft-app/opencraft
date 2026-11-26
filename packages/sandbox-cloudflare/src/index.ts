import {
  SandboxCreationFault,
  SandboxFault,
  type SandboxBackend,
  type SandboxEnvironment,
  type SandboxLoss,
  type SandboxProcess,
  type SandboxReceipt,
  type SandboxResources,
  type SandboxSnapshotRef,
} from "@opencraft/sandbox";
import { brokerSource, startBrokerProcess, type SandboxBrokerChannel } from "@opencraft/sandbox/broker";
import type { ContainerExecProcess, ContainerInstance, DurableObjectContainer } from "./bindings.js";

/** `cloudflare`: one Cloudflare Container held by the WorkspaceHost Durable Object
 * (`this.ctx.container`). The backend runs inside that Durable Object; it imports no
 * Workers or Node module, only the structural container port (./bindings).
 *
 * - **create** starts the container with a custom instance mapped from the requested
 *   budget and a random incarnation label, then identifies it with one `exec`: kernel
 *   boot id, CPU count, cgroup memory limit and the platform placement id. The
 *   receipt is `<incarnation>.<boot id>[.<placement id>]`, never the Durable Object
 *   name: one Durable Object hosts many incarnations over time.
 * - **spawn** is one `container.exec` of the shared broker (`@opencraft/sandbox/broker`):
 *   exec stdin is the control input (real back-pressure), the broker owns the process
 *   session, PTY and exit status. Exec `kill` reaches one process only and exec handles
 *   do not survive a Durable Object reset, so every guest process runs under a broker
 *   that reads its control input: a lost handle EOFs it and it kills its session.
 * - **attach** binds only a running container whose `inspect()` label and identity
 *   (boot id, placement) match the receipt; otherwise SANDBOX_UNAVAILABLE.
 * - **close** destroys the container (only while it still carries this incarnation)
 *   and completes once `monitor()` has settled; idempotent.
 * - **lost** settles from `monitor()` when the container stops without `close()`.
 * - The container inactivity timeout is a backstop, not a lifetime: it is set after
 *   start, on attach and on every backend initialization (a Durable Object restart
 *   does not retain it). */

export const CLOUDFLARE_PROVIDER_ID = "cloudflare";
/** `start({ labels })` key carrying the incarnation (label names are at most 16 bytes). */
export const CLOUDFLARE_INCARNATION_LABEL = "oc-incarnation";
/** Identity of a running container, read with one exec (as root; exec does not inherit
 * the start environment, so the placement id is read from PID 1). One JSON line. */
export const CLOUDFLARE_IDENTITY_SOURCE = String.raw`import json,os
def read(path):
    try:
        with open(path,'rb') as f: return f.read().decode('utf-8','replace').strip()
    except OSError: return None
placement=None
environ=read('/proc/1/environ')
for item in (environ or '').split('\0'):
    if item.startswith('CLOUDFLARE_PLACEMENT_ID='): placement=item.split('=',1)[1]
print(json.dumps({'boot':read('/proc/sys/kernel/random/boot_id'),'cpus':len(os.sched_getaffinity(0)),'memory':read('/sys/fs/cgroup/memory.max'),'placement':placement}))
`;
/** Largest custom instance an account gets by default (4 vCPU, 12 GiB, 20 GB). */
const MAXIMUM = { cpuMillis: 4000, memoryMib: 12 * 1024, diskMb: 20000 };
const MiB = 1024 ** 2;
const SNAPSHOT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface CloudflareSandboxOptions {
  /** `this.ctx.container` of the WorkspaceHost Durable Object. */
  readonly container: DurableObjectContainer;
  /** Digest-pinned image reference (a value of `container.images`). */
  readonly image: string;
  /** Absolute interpreter path in the image, for the shared broker and the identity probe. */
  readonly python?: string;
  /** Disk of the custom instance in MB (2000–20000). Default 20000. */
  readonly diskMb?: number;
  /** Default false: outbound traffic goes only through Worker intercepts. */
  readonly enableInternet?: boolean;
  /** Backstop only (the WorkspaceHost idle policy decides sleep); 1 ms – 6 h. */
  readonly inactivityTimeoutMs?: number;
  /** Bounded wait for provider calls (identity probe, broker start, monitor settle). */
  readonly requestTimeoutMs?: number;
  /** Numeric `uid:gid` for broker processes; absent: the image user. */
  readonly user?: string;
  /** Main-process environment (never credentials: the container holds none). */
  readonly env?: Readonly<Record<string, string>>;
  /** Installs the deployment's network policy before startup or reattachment. */
  prepareContainer?(): Promise<void>;
  /** The Durable Object's `ctx.waitUntil`, so a pending `monitor()` keeps the object
   * resident while the container runs. */
  waitUntil?(promise: Promise<unknown>): void;
  /** Lifecycle diagnostics carry fixed stage names and numeric exit codes only. */
  onLifecycle?(stage: string, exitCode?: number): void;
}

const fault = (code: ConstructorParameters<typeof SandboxFault>[0], message: string) => new SandboxFault(code, message);
const hex = (bytes: number) => {
  const value = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(value);
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};
const RECEIPT = /^([a-f0-9]{32})\.([a-f0-9]{32})(?:\.([A-Za-z0-9-]{1,64}))?$/u;
const PLACEMENT = /^[A-Za-z0-9-]{1,64}$/u;
const encoder = new TextEncoder();

/** Re-arms the container inactivity timeout of a running container. Call it in every
 * Durable Object construction (the platform does not retain it across restarts); the
 * backend also calls it on initialization, start and attach. */
export async function armCloudflareContainerTimeout(container: DurableObjectContainer, durationMs?: number) {
  if (durationMs === undefined || !container.running) return;
  await container.setInactivityTimeout(durationMs);
}

/** The custom instance for a budget: whole 1/8 vCPU steps, whole MiB, account maximums. */
export function cloudflareInstanceFor(resources: SandboxResources, diskMb: number): ContainerInstance | undefined {
  const memoryMib = resources.memoryBytes / MiB;
  if (
    !Number.isSafeInteger(resources.cpuMillis) ||
    resources.cpuMillis < 125 ||
    resources.cpuMillis > MAXIMUM.cpuMillis ||
    resources.cpuMillis % 125 !== 0 ||
    !Number.isSafeInteger(memoryMib) ||
    memoryMib < 256 ||
    memoryMib > MAXIMUM.memoryMib
  )
    return undefined;
  return { vcpu: resources.cpuMillis / 1000, memoryMib, diskMb };
}

interface Identity {
  readonly boot: string;
  readonly placement?: string;
  readonly resources: SandboxResources;
}

export function cloudflareSandboxBackend(options: CloudflareSandboxOptions): SandboxBackend {
  const container = options.container;
  const python = options.python ?? "/usr/bin/python3",
    diskMb = options.diskMb ?? MAXIMUM.diskMb,
    requestTimeoutMs = options.requestTimeoutMs ?? 30_000,
    startupTimeoutMs = options.requestTimeoutMs ?? 120_000,
    timeout = options.inactivityTimeoutMs;
  if (
    !container ||
    typeof options.image !== "string" ||
    !options.image ||
    !python.startsWith("/") ||
    python.includes("\0") ||
    !Number.isSafeInteger(diskMb) ||
    diskMb < 2000 ||
    diskMb > MAXIMUM.diskMb ||
    !Number.isSafeInteger(requestTimeoutMs) ||
    requestTimeoutMs < 1000 ||
    requestTimeoutMs > 120_000 ||
    (timeout !== undefined && (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 6 * 3600_000)) ||
    (options.user !== undefined && !/^\d{1,10}:\d{1,10}$/u.test(options.user))
  )
    throw fault("SANDBOX_POLICY", "Invalid Cloudflare provider configuration");
  let initialized = false,
    closed = false;
  const execOptions = { cwd: "/", ...(options.user ? { user: options.user } : {}) };
  const report = (stage: string, exitCode?: number) => {
    try {
      options.onLifecycle?.(stage, exitCode);
    } catch {}
  };

  const bounded = <T>(operation: Promise<T>, message: string, timeoutMs = requestTimeoutMs) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error(message)), timeoutMs);
      }),
    ]).finally(() => clearTimeout(timer));
  };

  /** One exec of the identity probe. A container that is still starting is waited for. */
  const identify = async (): Promise<Identity> => {
    const read = (async () => {
      const process = await container.exec([python, "-I", "-c", CLOUDFLARE_IDENTITY_SOURCE], {
        ...execOptions,
        stdout: "pipe",
        stderr: "ignore",
      }).catch((error: unknown) => {
        report(error instanceof Error && error.message === "The container has not been started"
          ? "identity-exec-not-started" : "identity-exec-failed");
        throw error;
      });
      const [text, code] = await Promise.all([new Response(process.stdout ?? null).text(), process.exitCode]);
      if (code !== 0) {
        report("identity-probe-exited", code);
        throw Error("identity probe failed");
      }
      return JSON.parse(text.trim().split("\n").at(-1) ?? "") as Record<string, unknown>;
    })();
    const value = await bounded(read, "Cloudflare container identity timed out", startupTimeoutMs);
    const boot = typeof value.boot === "string" ? value.boot.replaceAll("-", "").toLowerCase() : "";
    if (!/^[a-f0-9]{32}$/u.test(boot) || !Number.isSafeInteger(value.cpus) || (value.cpus as number) < 1)
      throw Error("Cloudflare container identity is invalid");
    const memory = typeof value.memory === "string" && /^\d{1,20}$/u.test(value.memory) ? Number(value.memory) : 0;
    return {
      boot,
      ...(typeof value.placement === "string" && PLACEMENT.test(value.placement) ? { placement: value.placement } : {}),
      // Fractional vCPU is a hypervisor quota the guest sees as whole CPUs; the guest
      // verifies the CPU count and the enforced cgroup memory limit.
      resources: { cpuMillis: (value.cpus as number) * 1000, memoryBytes: Number.isSafeInteger(memory) ? memory : 0 },
    };
  };
  /** What the guest observes for a requested budget: ceil(vCPU) CPUs and the exact memory. */
  const effective = (requested: SandboxResources, identity: Identity): SandboxResources => ({
    cpuMillis:
      identity.resources.cpuMillis === Math.ceil(requested.cpuMillis / 1000) * 1000
        ? requested.cpuMillis
        : identity.resources.cpuMillis,
    memoryBytes: identity.resources.memoryBytes,
  });

  /** A settled view of this incarnation's `monitor()`; the loss report when the owner did not close it. */
  const observe = () => {
    let settle!: (loss: SandboxLoss) => void;
    const stopped = new Promise<SandboxLoss>((resolve) => {
      settle = resolve;
    });
    let monitoring: Promise<void>;
    try {
      monitoring = container.monitor();
    } catch (error) {
      monitoring = Promise.reject(error);
    }
    const watched = monitoring.then(
      () => {
        report("monitor-exited", 0);
        settle({ reason: "exited", code: 0 });
      },
      (error: unknown) => {
        const code = (error as { exitCode?: unknown } | undefined)?.exitCode;
        const exitCode = typeof code === "number" && Number.isSafeInteger(code) ? code : undefined;
        report("monitor-stopped", exitCode);
        settle(exitCode === undefined ? { reason: "stopped" } : { reason: "crashed", code: exitCode });
      },
    );
    options.waitUntil?.(watched);
    return stopped;
  };

  const environmentFor = (
    incarnation: string,
    identity: Identity,
    resources: SandboxResources,
    stopped: Promise<SandboxLoss>,
  ): SandboxEnvironment => {
    const receipt: SandboxReceipt = Object.freeze({
      backend: CLOUDFLARE_PROVIDER_ID,
      instanceId: `${incarnation}.${identity.boot}${identity.placement ? `.${identity.placement}` : ""}`,
    });
    let ended = false,
      closing: Promise<void> | undefined,
      gone = false;
    void stopped.then(() => {
      gone = true;
    });
    let reportLoss!: (loss: SandboxLoss) => void;
    const lost = new Promise<SandboxLoss>((resolve) => {
      reportLoss = resolve;
    });
    void stopped.then((loss) => {
      if (!ended) reportLoss(loss);
    });
    const launch = async (onStdout: (chunk: string) => void): Promise<SandboxBrokerChannel> => {
      if (ended || gone) throw Error("Cloudflare container is not running");
      const process: ContainerExecProcess = await container.exec([python, "-I", "-u", "-c", brokerSource], {
        ...execOptions,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "ignore",
      });
      let exited = false;
      const exit = process.exitCode.then(
        (code) => {
          exited = true;
          return code;
        },
        () => {
          exited = true;
        },
      );
      if (!process.stdin || !process.stdout) {
        if (!exited) process.kill(9);
        throw Error("Cloudflare exec did not provide pipes");
      }
      const writer = process.stdin.getWriter(),
        reader = process.stdout.getReader(),
        decoder = new TextDecoder();
      const pump = (async () => {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            onStdout(decoder.decode(value, { stream: true }));
          }
        } catch {
          /* The stream ends with the process or the container. */
        }
      })();
      let disposed = false;
      return {
        // An exec handle may never settle once its container is gone; container stop ends it too.
        ended: Promise.race([pump.then(() => exit), stopped]),
        write: (frame) => writer.write(encoder.encode(frame)),
        dispose() {
          if (disposed) return;
          disposed = true;
          // Control-input EOF: the broker kills its session and exits. Only a broker that
          // is still running after the grace period is signalled; never an exited one.
          void writer.close().catch(() => {});
          const timer = setTimeout(
            () => {
              if (exited || gone) return;
              try {
                process.kill(9);
              } catch {}
            },
            Math.min(requestTimeoutMs, 5000),
          );
          void exit.then(() => clearTimeout(timer));
        },
      };
    };
    const environment: SandboxEnvironment = {
      receipt,
      resources: Object.freeze({ ...resources }),
      capabilities: { terminal: true },
      lost,
      spawn(command, onOutput): Promise<SandboxProcess> {
        if (ended || gone) return Promise.reject(fault("SANDBOX_START", "Cloudflare container is not running"));
        return startBrokerProcess({
          id: hex(12),
          command,
          onOutput,
          requestTimeoutMs,
          label: "Cloudflare",
          closeEnvironment: () => environment.close(),
          launch,
        });
      },
      close: () =>
        (closing ??= (async () => {
          ended = true;
          if (!gone) {
            let info: Awaited<ReturnType<DurableObjectContainer["inspect"]>>;
            try {
              info = container.running ? await bounded(container.inspect(), "inspect timed out") : null;
            } catch {
              throw fault("SANDBOX_CLEANUP", "Cloudflare container state is unconfirmed");
            }
            // A container that no longer carries this incarnation is not ours to stop.
            if (info?.labels?.[CLOUDFLARE_INCARNATION_LABEL] === incarnation)
              try {
                report("destroy-close");
                await bounded(container.destroy(), "destroy timed out");
              } catch {
                throw fault("SANDBOX_CLEANUP", "Cloudflare container destruction is unconfirmed");
              }
          }
          try {
            await bounded(stopped, "monitor did not settle");
          } catch {
            throw fault("SANDBOX_CLEANUP", "Cloudflare container destruction is unconfirmed");
          }
        })()),
    };
    return environment;
  };

  /** Stops a container this backend cannot account for (a stale incarnation in its own
   * Durable Object) before a create; nothing else ever runs there. */
  const reclaim = async () => {
    if (!container.running) return;
    const stopped = observe();
    await bounded(container.destroy(), "destroy timed out");
    await bounded(stopped, "monitor did not settle");
  };

  const start = async (resources: SandboxResources, signal: AbortSignal, snapshot?: SandboxSnapshotRef) => {
    if (!initialized || closed || signal.aborted) throw new SandboxCreationFault("not-created");
    const instance = cloudflareInstanceFor(resources, diskMb);
    if (!instance) throw new SandboxCreationFault("not-created");
    try {
      await reclaim();
    } catch {
      throw new SandboxCreationFault("not-created");
    }
    if (closed || signal.aborted) throw new SandboxCreationFault("not-created");
    const incarnation = hex(16);
    let stage = "network-policy";
    try {
      if (options.prepareContainer) await bounded(options.prepareContainer(), "container network policy timed out");
      if (closed || signal.aborted) throw new SandboxCreationFault("not-created");
      // Validates its options synchronously; a throw allocated nothing.
      stage = "container-start";
      container.start({
        ...(snapshot ? { containerSnapshot: { id: snapshot.id } } : { image: options.image }),
        enableInternet: options.enableInternet ?? false,
        instance,
        labels: { [CLOUDFLARE_INCARNATION_LABEL]: incarnation },
        ...(options.env ? { env: { ...options.env } } : {}),
      });
    } catch {
      report(`${stage}-failed`);
      throw new SandboxCreationFault("not-created");
    }
    // Submitted: never retried. Every later failure must reclaim the started container.
    report("start-accepted");
    const stopped = observe();
    try {
      stage = "inactivity-policy";
      await armCloudflareContainerTimeout(container, timeout);
      stage = "identity";
      const identity = await identify();
      report("identity-confirmed");
      stage = "inspect";
      const info = await bounded(container.inspect(), "inspect timed out");
      if (info?.labels?.[CLOUDFLARE_INCARNATION_LABEL] !== incarnation) throw Error("Incarnation label mismatch");
      report("incarnation-confirmed");
      return environmentFor(incarnation, identity, effective(resources, identity), stopped);
    } catch {
      report(`${stage}-failed`);
      try {
        if (container.running) {
          report("destroy-create-failed");
          await bounded(container.destroy(), "destroy timed out");
        }
        await bounded(stopped, "monitor did not settle");
      } catch {
        throw new SandboxCreationFault("unknown");
      }
      throw new SandboxCreationFault("not-created");
    }
  };

  return {
    id: CLOUDFLARE_PROVIDER_ID,
    async initialize(_policy, signal) {
      if (closed || signal.aborted || initialized)
        throw fault("SANDBOX_UNAVAILABLE", "Cloudflare provider is unavailable");
      // A Durable Object restart dropped the timeout of a container that kept running.
      await armCloudflareContainerTimeout(container, timeout).catch(() => {});
      initialized = true;
    },
    create: (_identity, resources, signal) => start(resources, signal),
    ...(container.snapshotContainer ? {
      async captureSnapshot(environment: SandboxEnvironment, signal: AbortSignal) {
        const incarnation = environment.receipt && RECEIPT.exec(environment.receipt.instanceId)?.[1];
        const check = async () => {
          signal.throwIfAborted();
          const running = incarnation && container.running && await bounded(container.inspect(), "inspect timed out");
          if (!running || running.labels[CLOUDFLARE_INCARNATION_LABEL] !== incarnation)
            throw fault("SANDBOX_UNAVAILABLE", "Cloudflare snapshot incarnation is unavailable");
        };
        await check();
        const takenAt = Date.now();
        const snapshot = await bounded(container.snapshotContainer!({}), "Cloudflare snapshot timed out", 120_000);
        await check();
        if (typeof snapshot?.id !== "string" || !snapshot.id)
          throw fault("SANDBOX_UNAVAILABLE", "Cloudflare did not return a snapshot identifier");
        report("snapshot-captured");
        return { backend: CLOUDFLARE_PROVIDER_ID, image: options.image, id: snapshot.id, takenAt, expiresAt: takenAt + SNAPSHOT_TTL_MS };
      },
      async restoreSnapshot(_identity, snapshot, resources, signal) {
        if (snapshot.backend !== CLOUDFLARE_PROVIDER_ID || snapshot.image !== options.image ||
          snapshot.expiresAt === undefined || snapshot.expiresAt <= Date.now()) throw new SandboxCreationFault("not-created");
        return start(resources, signal, snapshot);
      },
    } : {}),
    /** Binds the running container only when its label and identity are the receipt's. */
    async attach(_identity, receipt, resources, signal) {
      if (!initialized || closed || signal.aborted)
        throw fault("SANDBOX_UNAVAILABLE", "Cloudflare re-attach is unavailable");
      const parts = receipt?.backend === CLOUDFLARE_PROVIDER_ID ? RECEIPT.exec(receipt.instanceId) : null;
      if (!parts) throw fault("SANDBOX_UNAVAILABLE", "Receipt belongs to another provider");
      const [, incarnation, boot, placement] = parts as unknown as [string, string, string, string | undefined];
      let identity: Identity;
      try {
        if (!container.running) throw Error("not running");
        const info = await bounded(container.inspect(), "inspect timed out");
        if (info?.labels?.[CLOUDFLARE_INCARNATION_LABEL] !== incarnation) throw Error("different incarnation");
        identity = await identify();
        if (identity.boot !== boot || identity.placement !== placement) throw Error("different instance");
        if (options.prepareContainer) await bounded(options.prepareContainer(), "container network policy timed out");
      } catch {
        throw fault("SANDBOX_UNAVAILABLE", "Cloudflare container is gone or is another incarnation");
      }
      const stopped = observe();
      await armCloudflareContainerTimeout(container, timeout).catch(() => {});
      return environmentFor(incarnation, identity, effective(resources, identity), stopped);
    },
    /** WorkspaceRuntime saves a snapshot reference before sleep when configured.
     * Without one, the confirmed stop discards the container's writable disk. */
    async sleep(environment) {
      await environment.close();
    },
    async close() {
      closed = true;
    },
  };
}

export {
  cloudflareSandboxProvider,
  CLOUDFLARE_CONTAINER_CLASS,
  type CloudflareInstallation,
  type CloudflareProviderOptions,
} from "./provider.js";
export type * from "./bindings.js";
