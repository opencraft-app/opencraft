import { createHash, randomBytes } from "node:crypto";
import {
  SandboxCreationFault,
  type SandboxBackend,
  type SandboxIdentity,
  type SandboxResources,
} from "@opencraft/sandbox";
import type { EmployeeGitVaultStore } from "@opencraft/execution-environment/employee-git-vault-store";
import { PLATFORM_ASSET_SCOPE } from "../contract.js";

export type WorkspaceBudgetRole = "bot" | "ordinary";
export type WorkspaceBudgetOutcome = "not-created" | "destroyed" | "uncertain";
export interface WorkspaceBudgetPort {
  workspaceBudgetReserve(
    role: WorkspaceBudgetRole,
    identity: SandboxIdentity,
    resources: SandboxResources,
  ): Promise<string>;
  workspaceBudgetSettle(key: string, outcome: WorkspaceBudgetOutcome): Promise<void>;
}
interface Reservation {
  key: string;
  token?: string;
  role: WorkspaceBudgetRole;
  identity: SandboxIdentity;
  resources: SandboxResources;
  state: "reserved" | "uncertain";
}
const namespace = "document-installed-sandbox-budget";
function unavailable(): never {
  throw Error("Workspace budget unavailable");
}
const object = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  !!value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).every((key) => keys.includes(key));
const validIdentity = (value: SandboxIdentity) =>
  object(value, ["id", "owner", "backend"]) &&
  [value.id, value.owner, value.backend].every(
    (v) => typeof v === "string" && !!v && v.length <= 512 && !/[\x00-\x1f\x7f]/u.test(v),
  );
const validResources = (value: SandboxResources) =>
  object(value, ["cpuMillis", "memoryBytes"]) &&
  [value.cpuMillis, value.memoryBytes].every((v) => Number.isSafeInteger(v) && v > 0);
const identityKey = (role: WorkspaceBudgetRole, identity: SandboxIdentity) =>
  createHash("sha256")
    .update(JSON.stringify([role, identity.backend, identity.owner, identity.id]))
    .digest("hex");

/** Sole Assets Worker only. This records durable admission, not execution
 * authority, provider deletion evidence or a claim of kernel enforcement. */
export class WorkspaceBudgetStore {
  constructor(
    private readonly vault: Pick<EmployeeGitVaultStore, "readDocument" | "writeDocument">,
    private readonly capacity: () => SandboxResources,
  ) {}
  private read() {
    const stored = this.vault.readDocument(PLATFORM_ASSET_SCOPE, namespace);
    if (stored.document === null) return { revision: stored.revision, reservations: [] as Reservation[] };
    const doc = stored.document as { version: number; reservations: Reservation[] };
    if (
      !object(doc, ["version", "reservations"]) ||
      doc.version !== 1 ||
      !Array.isArray(doc.reservations) ||
      doc.reservations.length > 10000 ||
      doc.reservations.some(
        (r) =>
          !object(r, ["key", "token", "role", "identity", "resources", "state"]) ||
          !["bot", "ordinary"].includes(r.role) ||
          !validIdentity(r.identity) ||
          !validResources(r.resources) ||
          (r.token !== undefined && (typeof r.token !== "string" || !/^[a-f0-9]{32}$/u.test(r.token))) ||
          r.key !== identityKey(r.role, r.identity) ||
          !["reserved", "uncertain"].includes(r.state),
      ) ||
      new Set(doc.reservations.map((r) => r.key)).size !== doc.reservations.length
    )
      unavailable();
    return { revision: stored.revision, reservations: structuredClone(doc.reservations) };
  }
  reserve(role: WorkspaceBudgetRole, identity: SandboxIdentity, resources: SandboxResources): string {
    if (!["bot", "ordinary"].includes(role) || !validIdentity(identity) || !validResources(resources)) unavailable();
    const capacity = this.capacity(),
      stored = this.read(),
      key = identityKey(role, identity);
    if (
      !validResources(capacity) ||
      stored.reservations.length >= 10000 ||
      stored.reservations.some((r) => r.key === key)
    )
      unavailable();
    for (const dimension of ["cpuMillis", "memoryBytes"] as const) {
      let remaining = capacity[dimension];
      for (const reservation of stored.reservations) {
        remaining -= reservation.resources[dimension];
        if (!Number.isSafeInteger(remaining)) unavailable();
      }
      if (resources[dimension] > remaining) throw Error("Workspace capacity exhausted");
    }
    const token = randomBytes(16).toString("hex");
    this.vault.writeDocument(PLATFORM_ASSET_SCOPE, namespace, stored.revision, {
      version: 1,
      reservations: [
        ...stored.reservations,
        { key, token, role, identity: { ...identity }, resources: { ...resources }, state: "reserved" },
      ],
    });
    return `${key}.${token}`;
  }
  settle(receipt: string, outcome: WorkspaceBudgetOutcome): void {
    const match = typeof receipt === "string" && /^([a-f0-9]{64})\.([a-f0-9]{32})$/u.exec(receipt);
    if (!match || !["not-created", "destroyed", "uncertain"].includes(outcome)) unavailable();
    const key = match[1]!,
      token = match[2]!,
      stored = this.read();
    if (!stored.reservations.some((r) => r.key === key && r.token === token)) unavailable();
    this.vault.writeDocument(PLATFORM_ASSET_SCOPE, namespace, stored.revision, {
      version: 1,
      reservations:
        outcome === "uncertain"
          ? stored.reservations.map((r) => (r.key === key ? { ...r, state: "uncertain" } : r))
          : stored.reservations.filter((r) => r.key !== key),
    });
  }
}

/** Existing engine/provider owner calls this async port. No vault is opened in
 * Main, no cloud resource is created on initialization, and no mutation retries. */
export function withWorkspaceBudget(
  port: WorkspaceBudgetPort,
  role: WorkspaceBudgetRole,
  backend: SandboxBackend,
): SandboxBackend {
  return {
    id: backend.id,
    initialize: (policy, signal) => backend.initialize(policy, signal),
    close: () => backend.close(),
    async create(identity, resources, signal) {
      let key: string;
      try {
        signal.throwIfAborted();
        key = await port.workspaceBudgetReserve(role, identity, resources);
      } catch {
        throw new SandboxCreationFault("not-created", identity);
      } // Provider was never called; a lost reservation ack remains charged.
      if (signal.aborted) {
        await port.workspaceBudgetSettle(key, "not-created");
        throw new SandboxCreationFault("not-created", identity);
      }
      let environment;
      try {
        environment = await backend.create(identity, resources, signal);
      } catch (cause) {
        try {
          await port.workspaceBudgetSettle(
            key,
            cause instanceof SandboxCreationFault && cause.outcome === "not-created" ? "not-created" : "uncertain",
          );
        } catch (settlement) {
          throw new AggregateError([cause, settlement], "Workspace creation settlement unconfirmed");
        }
        throw cause;
      }
      let closing: Promise<void> | undefined;
      return {
        resources: environment.resources,
        capabilities: environment.capabilities,
        ...(environment.processLimits ? { processLimits: environment.processLimits } : {}),
        spawn: environment.spawn.bind(environment),
        close: () =>
          (closing ??= (async () => {
            try {
              await environment.close();
            } catch (cause) {
              try {
                await port.workspaceBudgetSettle(key, "uncertain");
              } catch (settlement) {
                throw new AggregateError([cause, settlement], "Workspace cleanup settlement unconfirmed");
              }
              throw cause;
            }
            await port.workspaceBudgetSettle(key, "destroyed");
          })()),
      };
    },
  };
}
