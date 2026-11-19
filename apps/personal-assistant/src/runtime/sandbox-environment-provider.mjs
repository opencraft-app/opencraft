import { createHash, randomUUID } from "node:crypto";
import { posix } from "node:path";
import { createSandboxPool, createSandbox, SandboxCreationFault } from "@opencraft/sandbox";
import { assertBotBinding, botBinding } from "../domain/bot-binding.mjs";
import { spawnAssistant } from "./host-supervisor.mjs";
const authorizeMethod = "opencraft/personal-assistant/authorize";
const invalid = () => {
  throw Error("Invalid isolated environment request");
};
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Installation composition for isolated execution only. The assistant brain, profile,
 * task ledger and model gateway stay local. The shared pool is the only allocator. */
export async function createSandboxAssistantProvider({
  backendId,
  templates,
  capacity,
  createBackend,
  spawnLocal = spawnAssistant,
  maxCommandMs = 60000,
  persistentWorkspaces = false,
  onReconciliation = () => {},
}) {
  if (
    !/^[a-z0-9][a-z0-9-]{0,63}$/.test(backendId) ||
    !Array.isArray(templates) ||
    !templates.length ||
    templates.length > 32 ||
    !Number.isSafeInteger(maxCommandMs) ||
    maxCommandMs < 100 ||
    maxCommandMs > 120000 ||
    typeof persistentWorkspaces !== "boolean"
  )
    invalid();
  const approved = new Map();
  for (const template of templates) {
    if (
      !/^[a-zA-Z0-9_-]{1,128}$/.test(template.id) ||
      approved.has(template.id) ||
      typeof template.name !== "string" ||
      !template.name.trim() ||
      template.name.length > 120 ||
      !template.resources ||
      !Number.isSafeInteger(template.resources.cpuMillis) ||
      template.resources.cpuMillis <= 0 ||
      !Number.isSafeInteger(template.resources.memoryBytes) ||
      template.resources.memoryBytes <= 0 ||
      !posix.isAbsolute(template.workspaceRoot) ||
      template.workspaceRoot.includes("\0") ||
      template.workspaceRoot === "/" ||
      (persistentWorkspaces && template.workspaceRoot !== "/workspace")
    )
      invalid();
    if (
      template.resources.cpuMillis > capacity?.cpuMillis ||
      template.resources.memoryBytes > capacity?.memoryBytes ||
      (template.python !== undefined && (!posix.isAbsolute(template.python) || template.python.includes("\0")))
    )
      invalid();
    const copy = structuredClone(template);
    copy.workspaceRoot = posix.resolve(copy.workspaceRoot);
    if (copy.workspaceRoot === "/") invalid();
    approved.set(template.id, copy);
  }
  const leases = new Map(),
    byAssignment = new Map(),
    byWorkspace = new Map(),
    backends = new Map(),
    initializing = new Map();
  let stopped = false,
    poolPolicy,
    poolSignal,
    closing;
  const authority = async (lease) => {
    if (stopped || lease.closed || lease.failed) throw Error("Isolated execution retired");
    const current = await lease.request(authorizeMethod, {});
    assertBotBinding(current.binding, lease.binding);
    if (current.epoch !== lease.epoch || current.expiresAt <= Date.now())
      throw Error("Isolated execution authority changed");
  };
  for (const template of approved.values())
    backends.set(
      template.id,
      await createBackend(template, {
        workspaceId: async (identity) => {
          const lease = leases.get(identity.owner);
          if (!lease) throw Error("Unknown isolated execution owner");
          await authority(lease);
          return lease.workspaceId;
        },
        authorize: async (identity) => {
          const lease = leases.get(identity.owner);
          if (!lease) throw Error("Unknown isolated execution owner");
          await authority(lease);
        },
        onLost: (identity) => {
          const lease = leases.get(identity.owner);
          if (lease) lease.failed = true;
        },
      }),
    );
  const pool = await createSandboxPool(
    {
      // Pool IDs have a smaller public bound than backend binding IDs.
      // Preserve short installation IDs; compact derived account/platform IDs.
      id: "assistant-" + (backendId.length <= 22 ? backendId : digest([backendId]).slice(0, 22)),
      capacity,
      defaults: [...approved.values()][0].resources,
      queueLimit: 0,
    },
    {
      id: backendId,
      async initialize(policy, signal) {
        poolPolicy = policy;
        poolSignal = signal;
      },
      async create(identity, resources, signal) {
        const lease = leases.get(identity.owner);
        if (!lease) throw new SandboxCreationFault("not-created");
        const backend = backends.get(lease.template.id);
        if (!initializing.has(lease.template.id))
          initializing.set(
            lease.template.id,
            Promise.resolve().then(() => backend.initialize(poolPolicy, poolSignal)),
          );
        try {
          await initializing.get(lease.template.id);
          await authority(lease);
        } catch {
          throw new SandboxCreationFault("not-created");
        }
        return backend.create(identity, resources, signal);
      },
      async close() {
        await Promise.all([...initializing.keys()].map((id) => backends.get(id).close()));
      },
    },
  );
  const validate = (environment) => {
    if (
      stopped ||
      environment?.kind !== "sandbox" ||
      environment.backendId !== backendId ||
      !approved.has(environment.templateId)
    )
      invalid();
  };
  const reportUncertain = (lease, identity) => {
    lease.uncertain = true;
    if (lease.reported) return;
    lease.reported = true;
    try {
      onReconciliation({
        backend: backendId,
        owner: lease.owner,
        ...(identity?.id ? { id: identity.id } : {}),
      });
    } catch {}
  };
  const destroy = async (lease) => {
    try {
      await lease.creating;
    } catch {}
    if (lease.sandbox) {
      try {
        await lease.sandbox.close();
      } catch (error) {
        reportUncertain(lease, lease.sandbox.identity);
        throw error;
      }
    }
    if (lease.uncertain) throw Error("Isolated environment requires operator reconciliation");
  };
  const ensure = (lease) =>
    (lease.creating ??= (async () => {
      await authority(lease);
      try {
        lease.sandbox = await createSandbox(pool, {
          owner: lease.owner,
          resources: lease.template.resources,
          signal: lease.controller.signal,
        });
        await authority(lease);
        const prepare = await lease.sandbox.spawn({
          command: [
            lease.template.python ?? "/usr/bin/python3",
            "-c",
            "import os,sys;os.makedirs(sys.argv[1],mode=0o700,exist_ok=True)",
            lease.workspace,
          ],
          cwd: "/tmp",
          env: {},
        });
        if ((await prepare.exited).code !== 0) throw Error("Isolated workspace unavailable");
        await authority(lease);
        return lease.sandbox;
      } catch (error) {
        lease.failed = true;
        if (error?.code === "SANDBOX_CREATION_UNCONFIRMED" || error?.code === "SANDBOX_CLEANUP")
          reportUncertain(lease, error.identity);
        if (lease.sandbox)
          try {
            await lease.sandbox.close();
          } catch {
            reportUncertain(lease, lease.sandbox?.identity);
          }
        throw Error("Isolated environment unavailable");
      }
    })());
  async function run(lease, params) {
    const keys = ["argv", "cwd", "timeoutMs", "workId", "callId"];
    if (
      !params ||
      Object.keys(params).some((k) => !keys.includes(k)) ||
      !Array.isArray(params.argv) ||
      !params.argv.length ||
      params.argv.length > 64 ||
      params.argv.some((a) => typeof a !== "string" || a.includes("\0") || a.length > 16384) ||
      JSON.stringify(params.argv).length > 32768 ||
      typeof params.workId !== "string" ||
      !params.workId ||
      params.workId.length > 200 ||
      typeof params.callId !== "string" ||
      !params.callId ||
      params.callId.length > 300
    )
      return { state: "rejected", reason: "invalid_input" };
    const relative = params.cwd ?? ".",
      timeoutMs = params.timeoutMs ?? Math.min(30000, maxCommandMs);
    if (
      typeof relative !== "string" ||
      relative.length > 1024 ||
      relative.includes("\0") ||
      posix.isAbsolute(relative) ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 100 ||
      timeoutMs > maxCommandMs
    )
      return { state: "rejected", reason: "invalid_input" };
    const cwd = posix.resolve(lease.workspace, relative);
    if (cwd !== lease.workspace && !cwd.startsWith(lease.workspace + "/"))
      return { state: "rejected", reason: "invalid_cwd" };
    await authority(lease);
    if (lease.active) return { state: "rejected", reason: "environment_busy" };
    const active = {
      workId: params.workId,
      callId: params.callId,
      controller: new AbortController(),
    };
    lease.active = active;
    const stop = () => {
      if (active.child)
        void active.child.terminate().catch(() => {
          lease.failed = true;
          void lease.sandbox?.close().catch(() => {
            reportUncertain(lease, lease.sandbox?.identity);
          });
        });
      else {
        lease.failed = true;
        lease.controller.abort();
      }
    };
    active.controller.signal.addEventListener("abort", stop, { once: true });
    const timer = setTimeout(() => active.controller.abort(), timeoutMs);
    timer.unref();
    let checking = false;
    const guard = setInterval(() => {
      if (checking) return;
      checking = true;
      void authority(lease)
        .catch(() => {
          lease.failed = true;
          active.controller.abort();
          void lease.sandbox?.close().catch(() => {
            reportUncertain(lease, lease.sandbox?.identity);
          });
        })
        .finally(() => {
          checking = false;
        });
    }, 2000);
    guard.unref();
    const stdout = [],
      stderr = [],
      sizes = { stdout: 0, stderr: 0 },
      hashes = { stdout: createHash("sha256"), stderr: createHash("sha256") };
    active.done = (async () => {
      let submitted = false;
      try {
        const sandbox = await ensure(lease);
        active.controller.signal.throwIfAborted();
        await authority(lease);
        submitted = true;
        active.child = await sandbox.spawn({ command: params.argv, cwd, env: {} }, (event) => {
          const bytes = Buffer.from(event.data),
            name = event.stream,
            remaining = Math.max(0, 32768 - sizes[name]);
          hashes[name].update(bytes);
          if (remaining) (name === "stdout" ? stdout : stderr).push(bytes.subarray(0, remaining));
          sizes[name] += bytes.length;
        });
        if (active.controller.signal.aborted) await active.child.terminate();
        else if (active.child.kind === "process") await active.child.closeStdin();
        const exit = await active.child.exited;
        await authority(lease);
        return {
          state: "completed",
          ...exit,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
          stdoutHash: hashes.stdout.digest("hex"),
          stderrHash: hashes.stderr.digest("hex"),
          truncated: sizes.stdout > 32768 || sizes.stderr > 32768,
          timedOut: active.controller.signal.aborted,
          workspace: lease.workspace,
          ephemeral: true,
        };
      } catch {
        if (submitted) {
          lease.failed = true;
          try {
            await lease.sandbox?.close();
          } catch {
            reportUncertain(lease, lease.sandbox?.identity);
          }
        }
        return {
          state: submitted ? "unknown" : "rejected",
          reason: submitted ? "effect_requires_reconciliation" : "environment_unavailable",
        };
      } finally {
        clearTimeout(timer);
        clearInterval(guard);
        active.controller.signal.removeEventListener("abort", stop);
        if (lease.active === active) lease.active = undefined;
      }
    })();
    return active.done;
  }
  async function closeLease(lease) {
    if (lease.closing) return lease.closing;
    lease.closed = true;
    lease.controller.abort();
    lease.active?.controller.abort();
    return (lease.closing = (async () => {
      try {
        await lease.handle?.close();
      } finally {
        await lease.active?.done;
        await destroy(lease);
        leases.delete(lease.owner);
        if (byAssignment.get(lease.key) === lease) byAssignment.delete(lease.key);
        if (lease.workspaceId && byWorkspace.get(lease.workspaceId) === lease) byWorkspace.delete(lease.workspaceId);
      }
    })());
  }
  return {
    async templates() {
      return stopped ? [] : [...approved.values()].map((t) => ({ id: t.id, name: t.name }));
    },
    async validate(environment) {
      validate(environment);
    },
    async spawn(environment, options) {
      validate(environment);
      const access = await options.request(authorizeMethod, {}),
        key = digest([access.binding, access.epoch]);
      if (byAssignment.has(key)) throw Error("Prior isolated execution is not retired");
      const binding = botBinding(access.binding);
      // Server/Bot/owner are authenticated persisted identities. Epochs, assignments
      // and execution incarnations are leases, not durable workspace identities.
      const workspaceId = persistentWorkspaces
        ? "ws-" +
          digest([
            "opencraft-workspace-v1",
            backendId,
            binding.serverId,
            binding.botId,
            binding.owner.kind,
            binding.owner.id,
          ]).slice(0, 32)
        : undefined;
      if (workspaceId && byWorkspace.has(workspaceId)) throw Error("Prior workspace execution is not retired");
      const owner = "assistant:" + randomUUID(),
        template = approved.get(environment.templateId),
        incarnation = randomUUID();
      const lease = {
        owner,
        key,
        template,
        binding,
        workspaceId,
        epoch: access.epoch,
        request: options.request,
        controller: new AbortController(),
        workspace: persistentWorkspaces ? template.workspaceRoot : posix.join(template.workspaceRoot, incarnation),
        failed: false,
        closed: false,
        uncertain: false,
      };
      leases.set(owner, lease);
      byAssignment.set(key, lease);
      if (workspaceId) byWorkspace.set(workspaceId, lease);
      const descriptor = {
        id: "execution.environment",
        binding: digest([access.binding, access.epoch, backendId, template.id, incarnation]),
        backendId,
        templateId: template.id,
        ephemeral: true,
      };
      try {
        lease.handle = spawnLocal({
          ...options,
          executionEnvironment: descriptor,
          request: async (method, params) => {
            if (method === "environment/run") return run(lease, params);
            if (method === "environment/cancel") {
              await authority(lease);
              if (params?.workId === lease.active?.workId && params?.callId === lease.active?.callId)
                lease.active.controller.abort();
              return { accepted: true };
            }
            return options.request(method, params);
          },
        });
        return {
          ...lease.handle,
          failed: () => lease.failed || lease.handle.failed(),
          close: () => closeLease(lease),
        };
      } catch {
        await closeLease(lease);
        throw Error("Isolated assistant could not start");
      }
    },
    close() {
      if (closing) return closing;
      stopped = true;
      return (closing = (async () => {
        const results = await Promise.allSettled([...leases.values()].map(closeLease));
        await pool.close();
        if (results.some((r) => r.status === "rejected")) throw Error("Isolated assistant cleanup is unconfirmed");
      })());
    },
  };
}
