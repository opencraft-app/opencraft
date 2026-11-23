import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import {
  Sandbox as E2BSandbox,
  SandboxNotFoundError,
  SandboxError,
  AuthenticationError,
} from "e2b";
import {
  SandboxCreationFault,
  SandboxFault,
  type SandboxBackend,
  type SandboxCommand,
  type SandboxEnvironment,
  type SandboxIdentity,
  type SandboxOutput,
  type SandboxPoolPolicy,
  type SandboxProcess,
} from "@opencraft/sandbox";
import { brokerSource, startBrokerProcess } from "@opencraft/sandbox/broker";

export interface E2BSandboxOptions {
  /** Trusted installation endpoints. Never accepted from Bot/task input. */
  apiUrl: string;
  sandboxUrl: string;
  templateId: string;
  /** Installation-owned secret reader; no credential is persisted in Bot configuration. */
  readApiKey(): Promise<string>;
  /** Trusted provider resolves this from an authorized persistent Bot binding. */
  readWorkspaceId?(identity: SandboxIdentity): Promise<string | undefined>;
  /** Private Host lifecycle receipt after remote identity verification. Failure
   * reclaims the exact created instance before reporting creation failure. */
  onCreated?(receipt: { identity: SandboxIdentity; workspaceId?: string; instanceId: string }): Promise<void>;
  timeoutMs?: number;
  requestTimeoutMs?: number;
  /** This template must provide Python 3 at this absolute path. */
  python?: string;
  /** Optional, bounded Host-owned renewal. Never resumes or recreates a lost instance. */
  lease?: {
    renewEveryMs: number;
    maxLifetimeMs: number;
    authorize(identity: SandboxIdentity): Promise<void>;
    onLost(identity: SandboxIdentity): void;
  };
}
type Remote = Pick<
  E2BSandbox,
  "sandboxId" | "getInfo" | "kill" | "files" | "commands" | "setTimeout"
>;
/** Injectable vendor boundary for deterministic lifecycle tests, not a second allocator. */
export interface E2BConnection {
  create: (
    template: string,
    options: Parameters<typeof E2BSandbox.create>[1],
  ) => Promise<Remote>;
  /** Reconnects to an existing sandbox by id (`Sandbox.connect`); never creates one. */
  connect?: (
    sandboxId: string,
    options: Parameters<typeof E2BSandbox.connect>[1],
  ) => Promise<Remote>;
}
const fault = (
  code: ConstructorParameters<typeof SandboxFault>[0],
  message: string,
) => new SandboxFault(code, message);
const endpoint = (raw: string) => {
  const url = new URL(raw);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    !(
      url.protocol === "https:" ||
      (url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    )
  )
    throw fault(
      "SANDBOX_POLICY",
      "E2B requires a trusted HTTPS endpoint or explicit loopback",
    );
  return url.origin;
};
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Optional E2B provider for the existing createSandboxPool/createSandbox contract.
 * Controller/Bot state stays local. This backend owns only remote execution leases. */
export function e2bSandboxBackend(
  options: E2BSandboxOptions,
  driver: E2BConnection = {
    create: (template, opts) => E2BSandbox.create(template, opts),
    connect: (sandboxId, opts) => E2BSandbox.connect(sandboxId, opts),
  },
): SandboxBackend {
  const templateId = options.templateId,
    readApiKey = options.readApiKey;
  const apiUrl = endpoint(options.apiUrl),
    sandboxUrl = endpoint(options.sandboxUrl),
    python = options.python ?? "/usr/bin/python3";
  const timeoutMs = options.timeoutMs ?? 300000,
    requestTimeoutMs = options.requestTimeoutMs ?? 60000;
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9_:/.-]{0,199}$/u.test(templateId) ||
    !isAbsolute(python) ||
    python.includes("\0") ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 10000 ||
    timeoutMs > 3600000 ||
    !Number.isSafeInteger(requestTimeoutMs) ||
    requestTimeoutMs < 1000 ||
    requestTimeoutMs > 120000
  )
    throw fault("SANDBOX_POLICY", "Invalid E2B provider configuration");
  const lease = options.lease;
  if (
    lease &&
    (!Number.isSafeInteger(lease.renewEveryMs) ||
      lease.renewEveryMs < 100 ||
      lease.renewEveryMs >= timeoutMs / 2 ||
      !Number.isSafeInteger(lease.maxLifetimeMs) ||
      lease.maxLifetimeMs < lease.renewEveryMs ||
      lease.maxLifetimeMs > 24 * 3600000 ||
      typeof lease.authorize !== "function" ||
      typeof lease.onLost !== "function")
  )
    throw fault("SANDBOX_POLICY", "Invalid E2B lease policy");
  let initialized = false,
    closed = false,
    apiKey: string;
  const requestOptions = { requestTimeoutMs };
  async function destroy(remote: Remote) {
    try {
      await remote.kill(requestOptions);
    } catch {
      /* Verify actual absence even after an ambiguous delete. */
    }
    for (let i = 0; i < 3; i++) {
      try {
        await remote.getInfo(requestOptions);
      } catch (error) {
        if (error instanceof SandboxNotFoundError) return;
        throw fault("SANDBOX_CLEANUP", "E2B destruction is unconfirmed");
      }
      if (i < 2) await delay(100);
    }
    throw fault("SANDBOX_CLEANUP", "E2B destruction is unconfirmed");
  }
  /** One live instance (created or re-attached): broker processes, lease, close. */
  function environmentFor(remote: Remote, identity: SandboxIdentity, info: Awaited<ReturnType<Remote["getInfo"]>>): SandboxEnvironment {
    const pending = new Set<Promise<SandboxProcess>>();
    let closing: Promise<void> | undefined,
      renewal: Promise<void> | undefined,
      timer: ReturnType<typeof setTimeout> | undefined,
      ended = false;
    const deadline = Date.now() + (lease?.maxLifetimeMs ?? timeoutMs);
    const environment: SandboxEnvironment = {
      receipt: Object.freeze({ backend: "e2b", instanceId: remote.sandboxId }),
      resources: {
        cpuMillis: info.cpuCount * 1000,
        memoryBytes: info.memoryMB * 1024 ** 2,
      },
      capabilities: { terminal: true },
      spawn(command, onOutput) {
        if (ended)
          return Promise.reject(
            fault("SANDBOX_START", "E2B execution is unavailable"),
          );
        const operation = startProcess(
          remote,
          identity,
          command,
          onOutput,
          python,
          requestTimeoutMs,
          () => environment.close(),
        );
        pending.add(operation);
        void operation
          .finally(() => pending.delete(operation))
          .catch(() => {});
        return operation;
      },
      close() {
        if (closing) return closing;
        ended = true;
        clearTimeout(timer);
        return (closing = (async () => {
          await renewal?.catch(() => {});
          await Promise.allSettled([...pending]);
          await destroy(remote);
        })());
      },
    };
    if (lease) {
      const schedule = () => {
        if (ended) return;
        timer = setTimeout(
          () => {
            renewal = (async () => {
              try {
                if (Date.now() >= deadline) throw Error();
                await lease.authorize(identity);
                if (ended) return;
                await remote.setTimeout(
                  Math.min(timeoutMs, Math.max(1000, deadline - Date.now())),
                  requestOptions,
                );
                if (!ended) schedule();
              } catch {
                if (!ended) {
                  try {
                    lease.onLost(identity);
                  } catch {}
                  void environment.close().catch(() => {});
                }
              }
            })();
          },
          Math.max(1, Math.min(lease.renewEveryMs, deadline - Date.now())),
        );
        timer.unref();
      };
      schedule();
    }
    return environment;
  }
  return {
    id: "e2b",
    async initialize(_policy: SandboxPoolPolicy, signal: AbortSignal) {
      if (closed || signal.aborted || initialized)
        throw fault("SANDBOX_UNAVAILABLE", "E2B provider is unavailable");
      const key = await readApiKey();
      if (
        typeof key !== "string" ||
        !key ||
        key.length > 4096 ||
        /\s/u.test(key)
      )
        throw fault("SANDBOX_POLICY", "E2B credential is unavailable");
      if (closed || signal.aborted)
        throw fault("SANDBOX_UNAVAILABLE", "E2B provider is unavailable");
      apiKey = key;
      initialized = true;
    },
    async create(identity, _resources, signal) {
      if (!initialized || closed || signal.aborted)
        throw new SandboxCreationFault("not-created");
      // Resolve before submitting create: authorization failure allocated nothing.
      let workspaceId: string | undefined;
      try {
        workspaceId = await options.readWorkspaceId?.(identity);
        if (workspaceId !== undefined && !/^ws-[a-f0-9]{32}$/.test(workspaceId))
          throw Error("Invalid workspace identity");
      } catch {
        throw new SandboxCreationFault("not-created");
      }
      if (signal.aborted || closed)
        throw new SandboxCreationFault("not-created");
      let remote: Remote;
      try {
        // Do not abort a submitted create or retry it: a late ID is needed for reclamation.
        remote = await driver.create(templateId, {
          apiUrl,
          sandboxUrl,
          apiKey,
          timeoutMs: Math.min(timeoutMs, lease?.maxLifetimeMs ?? timeoutMs),
          requestTimeoutMs,
          metadata: {
            ...(workspaceId ? { workspace_id: workspaceId } : {}),
            "opencraft-correlation": identity.id,
            "opencraft-owner": identity.owner,
          },
        });
      } catch (error) {
        // Beijing rejects occupied workspaces before allocating compute. Never
        // replace the stable ID or kill an unverified member to bypass this fence.
        if (
          error instanceof SandboxError &&
          error.statusCode === 409 &&
          (error.message.includes("workspace_in_use") ||
            // The JS SDK preserves the HTTP status but drops error_code.
            // Match only this definite pre-allocation refusal; other 409s,
            // including uncertain prior creates, remain unknown.
            error.message === "409: Workspace has live family members; connect to one, or delete the whole family before rebuilding")
        )
          throw new SandboxCreationFault("not-created");
        if (error instanceof AuthenticationError)
          throw new SandboxCreationFault("not-created");
        throw new SandboxCreationFault("unknown", identity);
      }
      let info: Awaited<ReturnType<Remote["getInfo"]>>;
      try {
        info = await remote.getInfo(requestOptions);
        if (workspaceId && info.metadata?.workspace_id !== workspaceId)
          throw Error("Remote workspace binding mismatch");
        await options.onCreated?.({ identity, ...(workspaceId ? { workspaceId } : {}), instanceId: remote.sandboxId });
      } catch {
        try {
          await destroy(remote);
        } catch {
          throw new SandboxCreationFault("unknown", identity);
        }
        throw new SandboxCreationFault("not-created");
      }
      return environmentFor(remote, identity, info);
    },
    /** Re-attach by receipt via `Sandbox.connect`. A missing or unverifiable instance
     * is lost (SANDBOX_UNAVAILABLE), never replaced. Connecting may resume a paused
     * sandbox; it never creates one. */
    async attach(identity, receipt, _resources, signal) {
      if (!initialized || closed || signal.aborted || !driver.connect)
        throw fault("SANDBOX_UNAVAILABLE", "E2B re-attach is unavailable");
      if (receipt?.backend !== "e2b" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/u.test(receipt.instanceId))
        throw fault("SANDBOX_UNAVAILABLE", "Receipt belongs to another provider");
      let remote: Remote, info: Awaited<ReturnType<Remote["getInfo"]>>;
      try {
        remote = await driver.connect(receipt.instanceId, { apiUrl, sandboxUrl, apiKey, requestTimeoutMs });
        info = await remote.getInfo(requestOptions);
        if (remote.sandboxId !== receipt.instanceId) throw Error("Different instance");
      } catch {
        throw fault("SANDBOX_UNAVAILABLE", "E2B instance is gone or cannot be verified");
      }
      return environmentFor(remote, identity, info);
    },
    async close() {
      closed = true;
      apiKey = "";
    },
  };
}

/** E2B supplies only the upload and launch of the shared broker; framing, process
 * state, termination and transport-loss semantics belong to @opencraft/sandbox/broker. */
function startProcess(
  remote: Remote,
  identity: SandboxIdentity,
  command: SandboxCommand,
  onOutput: ((output: SandboxOutput) => void) | undefined,
  python: string,
  requestTimeoutMs: number,
  closeEnvironment: () => Promise<void>,
): Promise<SandboxProcess> {
  const id = randomUUID(),
    path = "/tmp/opencraft-exec-" + identity.id + "-" + id + ".py";
  return startBrokerProcess({
    id,
    command,
    onOutput,
    requestTimeoutMs,
    label: "E2B",
    closeEnvironment,
    async launch(onStdout) {
      await remote.files.write(path, brokerSource, { requestTimeoutMs });
      const handle = await remote.commands.run("exec " + quote(python) + " -u " + quote(path), {
        background: true,
        stdin: true,
        timeoutMs: 0,
        requestTimeoutMs,
        shell: ["/bin/sh", "-c"],
        retainOutput: false,
        onStdout,
        onStderr: () => {},
      });
      return {
        ended: handle.wait(),
        write: async (frame) => {
          await handle.sendStdin(frame, { requestTimeoutMs });
        },
      };
    },
  });
}

export { createE2BPersistentWorkspaceInspector } from "./workspace-inspector.js";
export { e2bSandboxProvider, type E2BInstallation, type E2BProviderOptions } from "./provider.js";
