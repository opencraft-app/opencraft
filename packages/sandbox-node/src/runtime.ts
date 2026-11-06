import { lstat, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createSandboxPool, DEFAULT_SANDBOX_RESOURCES, SandboxFault, type SandboxBackend, type SandboxPool, type SandboxPoolPolicy } from "@opencraft/sandbox";
import { systemdSandboxBackend, type SystemdSandboxOptions } from "./systemd.js";
import { handsUnixSandboxBackend } from "./hands-unix.js";
import type { SandboxLifecycleEvent } from "./lifecycle.js";

const invalid = () => new SandboxFault("SANDBOX_POLICY", "Execution sandbox configuration is invalid");
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}
export interface SandboxRuntimeConfiguration {
  readonly schemaVersion: 1;
  readonly backend: { readonly id: string; readonly options: unknown };
  readonly pool: { readonly idPrefix: string; readonly capacity?: SandboxPoolPolicy["capacity"]; readonly defaults?: SandboxPoolPolicy["defaults"] };
  readonly environment: { readonly mode: "selected"; readonly names: readonly string[] } | { readonly mode: "local-inherit" };
}
export type SandboxBackendFactory = (options: unknown, lifecycle?: (event: SandboxLifecycleEvent) => void) => SandboxBackend | Promise<SandboxBackend>;

/** The assembly selects a provider. Engine consumers only use SandboxPool. */
export const nodeSandboxBackends: Readonly<Record<string, SandboxBackendFactory>> = Object.freeze({
  "hands-unix": async raw => {
    const value = record(raw);
    if (Object.keys(value).some(key => !["endpoint", "tokenFile"].includes(key))
      || ![value.endpoint, value.tokenFile].every(path => typeof path === "string" && path.startsWith("/"))) throw invalid();
    return handsUnixSandboxBackend(value as unknown as { endpoint: string; tokenFile: string });
  },
  "linux-systemd": async (raw, lifecycle) => {
    const value = record(raw);
    const accepted = ["scope", "uid", "gid", "inheritHostIdentity", "userNamespaceMapping", "parentSlice", "ownerUnit", "tasksMax", "poolTasksMax", "fileDescriptorsPerProcess"];
    if (Object.keys(value).some(key => !accepted.includes(key)) || !["system", "user"].includes(String(value.scope))) throw invalid();
    const uid = value.uid === "current" ? process.getuid?.() : value.uid;
    const gid = value.gid === "current" ? process.getgid?.() : value.gid;
    if (![uid, gid].every(n => typeof n === "number" && Number.isSafeInteger(n) && n >= 0)) throw invalid();
    for (const key of ["tasksMax", "poolTasksMax", "fileDescriptorsPerProcess"]) {
      if (value[key] !== undefined && !(typeof value[key] === "number" && Number.isSafeInteger(value[key]) && value[key] > 0)) throw invalid();
    }
    if (value.inheritHostIdentity !== undefined && typeof value.inheritHostIdentity !== "boolean") throw invalid();
    if (value.userNamespaceMapping !== undefined && typeof value.userNamespaceMapping !== "boolean") throw invalid();
    if (value.parentSlice !== undefined && typeof value.parentSlice !== "string") throw invalid();
    let ownerUnit = value.ownerUnit;
    if (ownerUnit === "current") {
      const location = (await readFile("/proc/self/cgroup", "utf8")).trim().split("\n").find(line => line.startsWith("0::"))?.slice(3);
      ownerUnit = location?.split("/").findLast(part => part.endsWith(".service"));
      if (!ownerUnit) throw new SandboxFault("SANDBOX_UNAVAILABLE", "Execution owner service is unavailable");
    }
    if (ownerUnit !== undefined && typeof ownerUnit !== "string") throw invalid();
    return systemdSandboxBackend({ ...value, uid, gid, ownerUnit, lifecycle } as unknown as SystemdSandboxOptions);
  },
});

export function parseSandboxRuntimeConfiguration(raw: unknown): SandboxRuntimeConfiguration {
  const value = record(raw), backend = record(value.backend), pool = record(value.pool), environment = record(value.environment);
  if (value.schemaVersion !== 1 || Object.keys(value).some(key => !["schemaVersion", "backend", "pool", "environment"].includes(key))
    || typeof backend.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(backend.id)
    || Object.keys(backend).some(key => !["id", "options"].includes(key))
    || typeof pool.idPrefix !== "string" || !/^[a-z0-9][a-z0-9-]{0,19}$/u.test(pool.idPrefix)
    || Object.keys(pool).some(key => !["idPrefix", "capacity", "defaults"].includes(key))) throw invalid();
  if (environment.mode === "local-inherit") {
    if (backend.id !== "linux-systemd" || Object.keys(environment).length !== 1) throw invalid();
  } else if (environment.mode === "selected") {
    if (!Array.isArray(environment.names) || environment.names.length > 1024 || environment.names.some(name => typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name))
      || Object.keys(environment).some(key => !["mode", "names"].includes(key))) throw invalid();
  } else throw invalid();
  return { schemaVersion: 1, backend: { id: backend.id, options: backend.options },
    pool: { idPrefix: pool.idPrefix, ...(pool.capacity === undefined ? {} : { capacity: pool.capacity as SandboxPoolPolicy["capacity"] }), ...(pool.defaults === undefined ? {} : { defaults: pool.defaults as SandboxPoolPolicy["defaults"] }) },
    environment: environment as unknown as SandboxRuntimeConfiguration["environment"] };
}

export async function readSandboxRuntimeConfiguration(path: string): Promise<SandboxRuntimeConfiguration> {
  try {
    const file = await lstat(path);
    if (!file.isFile() || file.uid !== process.getuid?.() || (file.mode & 0o077) !== 0 || file.size > 32 * 1024) throw invalid();
    return parseSandboxRuntimeConfiguration(JSON.parse(await readFile(path, "utf8")));
  } catch { throw invalid(); }
}

export async function configuredSandboxPool(config: SandboxRuntimeConfiguration, factories: Readonly<Record<string, SandboxBackendFactory>> = nodeSandboxBackends, lifecycle?: (event: SandboxLifecycleEvent) => void): Promise<SandboxPool> {
  const selected = parseSandboxRuntimeConfiguration(config), factory = Object.hasOwn(factories, selected.backend.id) ? factories[selected.backend.id] : undefined;
  if (!factory) throw new SandboxFault("SANDBOX_UNAVAILABLE", "Selected sandbox provider is not installed");
  const backend = await factory(selected.backend.options, lifecycle);
  return createSandboxPool({ id: selected.pool.idPrefix + "-" + randomUUID().replaceAll("-", "").slice(0, 10),
    capacity: selected.pool.capacity ?? DEFAULT_SANDBOX_RESOURCES, defaults: selected.pool.defaults }, backend);
}

export function sandboxPayloadEnvironment(config: SandboxRuntimeConfiguration, source: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const selected = parseSandboxRuntimeConfiguration(config);
  const names = selected.environment.mode === "selected" ? selected.environment.names : Object.keys(source);
  return Object.fromEntries(names.flatMap(key => source[key] === undefined ? [] : [[key, source[key]!]]));
}

/** The Linux generation owner also bounds native auxiliary processes that never
 * enter exec-server (for example its standalone command API). Core is separate. */
export function systemdExecutionOwnerProperties(config: SandboxRuntimeConfiguration): string[] {
  const selected = parseSandboxRuntimeConfiguration(config);
  if (selected.backend.id !== "linux-systemd") return [];
  const options = record(selected.backend.options);
  const resources = { ...DEFAULT_SANDBOX_RESOURCES, ...selected.pool.defaults };
  if (options.parentSlice !== undefined && (typeof options.parentSlice !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}\.slice$/u.test(options.parentSlice))) throw invalid();
  const tasks = options.tasksMax ?? 4096, fds = options.fileDescriptorsPerProcess ?? 65536;
  if (![resources.cpuMillis, resources.memoryBytes, tasks, fds].every(n => typeof n === "number" && Number.isSafeInteger(n) && n > 0)) throw invalid();
  return [...(options.parentSlice ? ["--slice=" + options.parentSlice] : []),
    "--property=CPUQuota=" + resources.cpuMillis / 10 + "%", "--property=MemoryMax=" + resources.memoryBytes,
    "--property=MemoryHigh=" + Math.floor(resources.memoryBytes * 0.75), "--property=MemorySwapMax=0",
    "--property=TasksMax=" + tasks, "--property=LimitNOFILE=" + fds, "--property=OOMPolicy=continue"];
}

export async function verifySystemdExecutionOwner(config: SandboxRuntimeConfiguration): Promise<boolean> {
  if (config.backend.id !== "linux-systemd") return false;
  const resources = { ...DEFAULT_SANDBOX_RESOURCES, ...config.pool.defaults };
  const location = (await readFile("/proc/self/cgroup", "utf8")).trim().split("\n").find(line => line.startsWith("0::"))?.slice(3);
  const parts = location?.split("/"), service = parts?.findLastIndex(part => part.endsWith(".service"));
  const group = parts && service !== undefined && service > 0 ? parts.slice(0, service + 1).join("/") : undefined;
  if (!group?.startsWith("/") || group.includes("..")) throw invalid();
  const [cpu, memory, tasks] = await Promise.all(["cpu.max", "memory.max", "pids.max"].map(name => readFile("/sys/fs/cgroup" + group + "/" + name, "utf8")));
  const [quota, period] = cpu.trim().split(/\s+/u).map(Number);
  const options = record(config.backend.options);
  if (options.parentSlice && !group.includes("/" + options.parentSlice + "/")) throw invalid();
  if (!quota || !period || quota / period * 1000 > resources.cpuMillis || !(Number(memory) > 0 && Number(memory) <= resources.memoryBytes)
    || !(Number(tasks) > 0 && Number(tasks) <= Number(options.tasksMax ?? 4096))) throw new SandboxFault("SANDBOX_UNAVAILABLE", "Native execution owner is not resource bounded");
  return true;
}
