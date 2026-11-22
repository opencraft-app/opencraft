import { isAbsolute } from "node:path";
import { isSandboxBackendId, type SandboxBackendId } from "./sandbox-installations.js";
export interface InstalledSandboxPolicy {
  /** The one provider selected for this installation; every template credential uses it. */
  backendId: SandboxBackendId;
  capacity: { cpuMillis: number; memoryBytes: number };
  lease: { timeoutMs: number; renewEveryMs: number; maxLifetimeMs: number };
  maxCommandMs: number;
  persistentWorkspaces: boolean;
  templates: {
    environmentId: string;
    workspaceRoot: string;
    resources: { cpuMillis: number; memoryBytes: number };
    python?: string;
    /** Trusted installed delivery, never a renderer-provided path. */
    browser?: { isolation: "chromium-sandbox" | "isolated-vm-compatibility" };
  }[];
}
const invalid = () => {
  throw Error("Invalid installed sandbox policy");
};
export function validateInstalledPolicy(p: InstalledSandboxPolicy) {
  if (
    !p ||
    !isSandboxBackendId(p.backendId) ||
    Object.keys(p).some(
      (k) => !["backendId", "capacity", "lease", "maxCommandMs", "persistentWorkspaces", "templates"].includes(k),
    ) ||
    typeof p.persistentWorkspaces !== "boolean" ||
    !Array.isArray(p.templates) ||
    p.templates.length > 32
  )
    invalid();
  const resources = (v: InstalledSandboxPolicy["capacity"]) => {
    if (
      !v ||
      Object.keys(v).some((k) => !["cpuMillis", "memoryBytes"].includes(k)) ||
      ![v.cpuMillis, v.memoryBytes].every((n) => Number.isSafeInteger(n) && n > 0)
    )
      invalid();
  };
  resources(p.capacity);
  if (
    !p.lease ||
    Object.keys(p.lease).some((k) => !["timeoutMs", "renewEveryMs", "maxLifetimeMs"].includes(k)) ||
    ![p.lease.timeoutMs, p.lease.renewEveryMs, p.lease.maxLifetimeMs, p.maxCommandMs].every(
      (n) => Number.isSafeInteger(n) && n > 0,
    ) ||
    p.lease.timeoutMs < 10000 ||
    p.lease.timeoutMs > 3600000 ||
    p.lease.renewEveryMs < 100 ||
    p.lease.renewEveryMs >= p.lease.timeoutMs / 2 ||
    p.lease.maxLifetimeMs < p.lease.renewEveryMs ||
    p.lease.maxLifetimeMs > 86400000 ||
    p.maxCommandMs < 100 ||
    p.maxCommandMs > 120000
  )
    invalid();
  const ids = new Set();
  for (const t of p.templates) {
    resources(t.resources);
    if (
      !t ||
      Object.keys(t).some((k) => !["environmentId", "workspaceRoot", "resources", "python", "browser"].includes(k)) ||
      typeof t.environmentId !== "string" ||
      !t.environmentId ||
      t.environmentId.length > 64 ||
      ids.has(t.environmentId) ||
      !isAbsolute(t.workspaceRoot) ||
      t.workspaceRoot === "/" ||
      t.workspaceRoot.includes("\0") ||
      (p.persistentWorkspaces && t.workspaceRoot !== "/workspace") ||
      t.resources.cpuMillis > p.capacity.cpuMillis ||
      t.resources.memoryBytes > p.capacity.memoryBytes ||
      (t.python !== undefined && (!isAbsolute(t.python) || t.python.includes("\0")))
    )
      invalid();
    if (t.browser !== undefined) {
      if (
        !t.browser ||
        Object.keys(t.browser).some((k) => !["isolation"].includes(k)) ||
        !["chromium-sandbox", "isolated-vm-compatibility"].includes(t.browser.isolation)
      )
        invalid();
    }
    ids.add(t.environmentId);
  }
}
