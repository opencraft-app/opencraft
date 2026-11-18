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
  type SandboxExit,
  type SandboxIdentity,
  type SandboxOutput,
  type SandboxPoolPolicy,
  type SandboxProcess,
} from "@opencraft/sandbox";
import { brokerSource } from "./broker.js";

export interface E2BSandboxOptions {
  /** Trusted installation endpoints. Never accepted from Bot/task input. */
  apiUrl: string;
  sandboxUrl: string;
  templateId: string;
  /** Installation-owned secret reader; no credential is persisted in Bot configuration. */
  readApiKey(): Promise<string>;
  /** Trusted provider resolves this from an authorized persistent Bot binding. */
  readWorkspaceId?(identity: SandboxIdentity): Promise<string | undefined>;
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
const frame = (value: unknown) =>
  JSON.stringify(value)
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029") + "\n";
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Optional E2B provider for the existing createSandboxPool/createSandbox contract.
 * Controller/Bot state stays local. This backend owns only remote execution leases. */
export function e2bSandboxBackend(
  options: E2BSandboxOptions,
  driver: E2BConnection = {
    create: (template, opts) => E2BSandbox.create(template, opts),
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
      } catch {
        try {
          await destroy(remote);
        } catch {
          throw new SandboxCreationFault("unknown", identity);
        }
        throw new SandboxCreationFault("not-created");
      }
      const pending = new Set<Promise<SandboxProcess>>();
      let closing: Promise<void> | undefined,
        renewal: Promise<void> | undefined,
        timer: ReturnType<typeof setTimeout> | undefined,
        ended = false;
      const deadline = Date.now() + (lease?.maxLifetimeMs ?? timeoutMs);
      const environment: SandboxEnvironment = {
        resources: {
          cpuMillis: info.cpuCount * 1000,
          memoryBytes: info.memoryMB * 1024 ** 2,
        },
        capabilities: { terminal: false },
        spawn(command, onOutput) {
          if (ended || command.terminal)
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
    },
    async close() {
      closed = true;
      apiKey = "";
    },
  };
}

async function startProcess(
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
  let resolveStart!: () => void,
    rejectStart!: (error: Error) => void,
    resolveExit!: (exit: SandboxExit) => void,
    rejectExit!: (error: Error) => void;
  let started = false,
    finished = false,
    broken = false,
    buffer = "",
    stdinClosed = false;
  const ready = new Promise<void>((resolve, reject) => {
    resolveStart = resolve;
    rejectStart = reject;
  });
  const exited = new Promise<SandboxExit>((resolve, reject) => {
    resolveExit = resolve;
    rejectExit = reject;
  });
  void ready.catch(() => {});
  void exited.catch(() => {});
  const failure = () => {
    if (broken || finished) return;
    broken = true;
    const error = fault("SANDBOX_START", "E2B execution transport failed");
    rejectStart(error);
    rejectExit(error);
    // Do not reconnect or replay process input. The caller still owns close()/capacity.
    // Defer until the pending launch leaves the environment's tracked set.
    setTimeout(() => {
      void closeEnvironment().catch(() => {});
    }, 0);
  };
  const accept = (chunk: string) => {
    if (broken) return;
    buffer += chunk;
    for (;;) {
      const at = buffer.indexOf("\n");
      if (at < 0) break;
      if (at > 512 * 1024) {
        failure();
        return;
      }
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      try {
        const value = JSON.parse(line);
        if (value.type === "started" && !started) {
          started = true;
          resolveStart();
        } else if (
          value.type === "output" &&
          started &&
          !finished &&
          (value.stream === "stdout" || value.stream === "stderr") &&
          typeof value.data === "string"
        )
          onOutput?.({
            stream: value.stream,
            data: Buffer.from(value.data, "base64"),
          });
        else if (
          value.type === "exit" &&
          started &&
          !finished &&
          (value.code === null || Number.isSafeInteger(value.code))
        ) {
          finished = true;
          resolveExit({
            code: value.code,
            ...(value.signal ? { signal: String(value.signal) } : {}),
          });
        } else throw Error();
      } catch {
        failure();
        return;
      }
    }
    if (buffer.length > 512 * 1024) failure();
  };
  let handle: Awaited<ReturnType<Remote["commands"]["run"]>>;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await remote.files.write(path, brokerSource, { requestTimeoutMs });
    // Broker receives argv/cwd/payload environment privately through stdin, not shell argv.
    handle = await remote.commands.run(
      "exec " + quote(python) + " -u " + quote(path),
      {
        background: true,
        stdin: true,
        timeoutMs: 0,
        requestTimeoutMs,
        shell: ["/bin/sh", "-c"],
        retainOutput: false,
        onStdout: accept,
        onStderr: () => {},
      },
    );
    void handle.wait().then(() => {
      if (!finished) failure();
    }, failure);
    timer = setTimeout(failure, Math.min(requestTimeoutMs, 15000));
    const input = frame({ type: "start", command });
    if (Buffer.byteLength(input) > 384 * 1024) throw Error();
    await handle.sendStdin(input, { requestTimeoutMs });
    await ready;
  } catch {
    failure();
    throw fault("SANDBOX_START", "E2B process could not start");
  } finally {
    clearTimeout(timer);
  }
  let input = Promise.resolve();
  const enqueue = (operation: () => Promise<void>) => {
    const next = input.then(operation);
    input = next.catch(() => {});
    return next;
  };
  const sendFrame = async (value: unknown) => {
    if (broken || finished)
      throw fault("SANDBOX_CLOSED", "E2B process is closed");
    try {
      await handle.sendStdin(frame(value), { requestTimeoutMs });
    } catch {
      failure();
      throw fault("SANDBOX_START", "E2B input transport failed");
    }
  };
  return {
    kind: "process",
    id,
    exited,
    async writeStdin(data) {
      if (stdinClosed)
        throw fault("SANDBOX_CLOSED", "E2B process stdin is closed");
      // One bounded chunk at a time; preserve ordering against concurrent writes/EOF.
      return enqueue(async () => {
        for (let offset = 0; offset < data.length; offset += 128 * 1024)
          await sendFrame({
            type: "stdin",
            data: Buffer.from(
              data.subarray(offset, offset + 128 * 1024),
            ).toString("base64"),
          });
      });
    },
    async closeStdin() {
      if (stdinClosed || finished) return;
      stdinClosed = true;
      await enqueue(async () => {
        if (finished) return;
        try { await sendFrame({ type: "eof" }); }
        catch (error) { if (!finished) throw error; }
      });
    },
    async terminate() {
      if (finished) return;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          enqueue(() => sendFrame({ type: "terminate" })).then(() => exited),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(
              () =>
                reject(
                  fault(
                    "SANDBOX_START",
                    "E2B termination was not acknowledged",
                  ),
                ),
              Math.min(requestTimeoutMs, 15000),
            );
          }),
        ]);
      } catch {
        await closeEnvironment();
        throw fault(
          "SANDBOX_START",
          "E2B process termination required environment teardown",
        );
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
