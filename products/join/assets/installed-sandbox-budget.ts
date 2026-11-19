import { createHash } from "node:crypto";
import { SandboxCreationFault, type SandboxBackend, type SandboxResources, type SandboxIdentity } from "../../../packages/sandbox/src/index";
import type { EmployeeGitVaultStore } from "../../../scripts/employee-git-vault-store";
import { PLATFORM_ASSET_SCOPE } from "./contract";

const namespace = "document-installed-sandbox-budget";
type Record = { key: string; role: "bot" | "ordinary"; identity: SandboxIdentity; resources: SandboxResources; state: "reserved" | "uncertain" };
const identityKey = (role: string, identity: SandboxIdentity) =>
  createHash("sha256").update(JSON.stringify([role, identity.backend, identity.owner, identity.id])).digest("hex");
const validIdentity = (i: SandboxIdentity) => i && [i.id, i.owner, i.backend].every(
  v => typeof v === "string" && v.length > 0 && v.length <= 512 && !/[\x00-\x1f\x7f]/u.test(v));
const valid = (r: SandboxResources) => r && Number.isSafeInteger(r.cpuMillis) && r.cpuMillis > 0
  && Number.isSafeInteger(r.memoryBytes) && r.memoryBytes > 0;

/** Installed Bot and ordinary pools share this durable outer admission budget.
 * A missing cleanup receipt is never made free by provider/process restart.
 * This ledger does not authorize execution or delete remote instances. */
export class InstalledSandboxBudget {
  constructor(private readonly vault: Pick<EmployeeGitVaultStore, "readDocument" | "writeDocument">,
    private readonly capacity: () => SandboxResources) {}
  private read() {
    const value = this.vault.readDocument(PLATFORM_ASSET_SCOPE, namespace);
    if (value.document === null) return { revision: value.revision, reservations: [] as Record[] };
    const doc = value.document as { version: number; reservations: Record[] };
    if (!doc || doc.version !== 1 || !Array.isArray(doc.reservations) || doc.reservations.length > 10000
      || doc.reservations.some(r => !r || !/^[a-f0-9]{64}$/.test(r.key) || !valid(r.resources)
        || !["bot", "ordinary"].includes(r.role) || !validIdentity(r.identity) || identityKey(r.role, r.identity) !== r.key
        || !["reserved", "uncertain"].includes(r.state))
      || new Set(doc.reservations.map(r => r.key)).size !== doc.reservations.length)
      throw Error("Installed sandbox budget unavailable");
    return { revision: value.revision, reservations: doc.reservations };
  }
  private reserve(key: string, role: "bot" | "ordinary", identity: SandboxIdentity, resources: SandboxResources) {
    const capacity = this.capacity(), value = this.read();
    if (!validIdentity(identity) || !valid(capacity) || !valid(resources) || value.reservations.length >= 10000
      || value.reservations.some(r => r.key === key)) throw Error("Installed sandbox budget unavailable");
    for (const dimension of ["cpuMillis", "memoryBytes"] as const) {
      let remaining = capacity[dimension];
      for (const r of value.reservations) remaining -= r.resources[dimension];
      if (resources[dimension] > remaining) throw Error("Installed sandbox capacity exhausted");
    }
    this.vault.writeDocument(PLATFORM_ASSET_SCOPE, namespace, value.revision,
      { version: 1, reservations: [...value.reservations, { key, role, identity: { ...identity }, resources: { ...resources }, state: "reserved" }] });
  }
  private finish(key: string, remove: boolean) {
    const value = this.read();
    if (!value.reservations.some(r => r.key === key)) throw Error("Installed sandbox reservation missing");
    this.vault.writeDocument(PLATFORM_ASSET_SCOPE, namespace, value.revision, {
      version: 1, reservations: remove ? value.reservations.filter(r => r.key !== key)
        : value.reservations.map(r => r.key === key ? { ...r, state: "uncertain" } : r),
    });
  }
  wrap(role: "bot" | "ordinary", backend: SandboxBackend): SandboxBackend {
    return {
      id: backend.id,
      initialize: (policy, signal) => backend.initialize(policy, signal),
      close: () => backend.close(),
      create: async (identity, resources, signal) => {
        const key = identityKey(role, identity);
        try { signal.throwIfAborted(); this.reserve(key, role, identity, resources); }
        catch { throw new SandboxCreationFault("not-created", identity); }
        let environment;
        try { environment = await backend.create(identity, resources, signal); }
        catch (error) {
          this.finish(key, error instanceof SandboxCreationFault && error.outcome === "not-created");
          throw error;
        }
        let closing: Promise<void> | undefined;
        return {
          resources: environment.resources, capabilities: environment.capabilities,
          ...(environment.processLimits ? { processLimits: environment.processLimits } : {}),
          spawn: environment.spawn.bind(environment),
          close: () => closing ??= (async () => {
            try { await environment.close(); }
            catch (error) { this.finish(key, false); throw error; }
            this.finish(key, true);
          })(),
        };
      },
    };
  }
}
