import { createHash } from "node:crypto";
import { PLATFORM_ASSET_SCOPE } from "@opencraft/plugin-assets/contract";
import type { SandboxConfigurations } from "@opencraft/plugin-assets/server/configurations";
import { WorkspaceActorAuthority, workspaceAdmission, type WorkspaceActorAdmission } from "./actor-authority.js";

/** Where a Bot environment's configuration and credential live. */
export type BotEnvironmentSource = "personal" | "platform" | "installed";
/** Secret-free projection of one saved personal or platform configuration. */
export interface BotEnvironmentRecord {
  readonly source: "personal" | "platform";
  readonly environment: { readonly id: string; readonly name: string; readonly templateId: string };
  readonly credential: {
    readonly id: string;
    readonly generation: string;
    readonly apiUrl: string;
    readonly sandboxUrl: string;
  };
}
/** The admitted Human whose Bot environments are resolved. `scope` is the
 * canonical vault partition (`actor:<actorId>`) its personal records live in. */
export interface BotEnvironmentActor {
  readonly actorId: string;
  readonly generation: number;
  readonly scope: string;
}
/** Compiled composition hook: the identity partition a personal backend ID is
 * derived from. The default is the Actor's canonical partition. A composition
 * whose existing Bots were bound to IDs derived from an older account partition
 * returns that partition here so those Bots keep their backend. Throwing denies
 * the Actor's catalogue. Never consulted for platform or installed sources. */
export type BotBackendIdentity = (record: BotEnvironmentRecord, actor: BotEnvironmentActor) => string;
/** Resolved resource owner of an admission; `custom` allows custom endpoints. */
export interface BotEnvironmentOwner {
  readonly scope: string;
  readonly custom: boolean;
}

type RuntimeRecord = ReturnType<SandboxConfigurations["runtime"]>[number];
type Configurations = Pick<SandboxConfigurations, "runtime" | "installedRuntime">;
export type ResolvedBotEnvironment =
  | {
      source: "personal" | "platform";
      backendId: string;
      fingerprint: string;
      templates: { id: string; name: string }[];
      record: RuntimeRecord;
    }
  | { source: "installed"; backendId: "e2b"; fingerprint: string; templates: { id: string; name: string }[] };
export interface BotEnvironmentCatalog {
  revision: string;
  environments: ResolvedBotEnvironment[];
}

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const unavailableBotEnvironment = () =>
  Error("Bot environment unavailable; physical operations must not be replayed");
const deny = (): never => {
  throw unavailableBotEnvironment();
};
/** Stable, secret-free identity of one saved configuration. A key rotation
 * changes the credential generation, so it requires a new explicit selection. */
export function botRecordFingerprint(record: RuntimeRecord, source: "personal" | "platform") {
  return hash([
    ...(source === "platform" ? ["platform"] : []),
    record.environment.id,
    record.environment.templateId,
    record.credential.id,
    record.credential.generation,
    record.credential.apiUrl,
    record.credential.sandboxUrl,
  ]);
}
/** Fingerprint of the whole installed source: its policy and every record. */
export function installedBotFingerprint(installed: NonNullable<ReturnType<Configurations["installedRuntime"]>>) {
  return hash([
    installed.policy,
    installed.records.map((r) => [
      r.environment.id,
      r.environment.templateId,
      r.credential.id,
      r.credential.generation,
      r.credential.apiUrl,
      r.credential.sandboxUrl,
    ]),
  ]);
}
const projection = (record: RuntimeRecord, source: "personal" | "platform"): BotEnvironmentRecord =>
  Object.freeze({
    source,
    environment: Object.freeze({
      id: record.environment.id,
      name: record.environment.name,
      templateId: record.environment.templateId,
    }),
    credential: Object.freeze({
      id: record.credential.id,
      generation: record.credential.generation,
      apiUrl: record.credential.apiUrl,
      sandboxUrl: record.credential.sandboxUrl,
    }),
  });
export const defaultBotBackendIdentity: BotBackendIdentity = (_record, actor) => actor.scope;
function identityOf(backendIdentity: BotBackendIdentity, record: RuntimeRecord, actor: BotEnvironmentActor) {
  const value = backendIdentity(projection(record, "personal"), Object.freeze({ ...actor }));
  if (typeof value !== "string" || !value || value.length > 256 || /[\x00-\x1f\x7f]/u.test(value)) return deny();
  return value;
}

/** Platform records that are not part of the installation. An installed
 * template is published once, as the installed source. */
export function platformBotRecords(configurations: Configurations) {
  const installed = new Set(configurations.installedRuntime()?.records.map((r) => r.environment.id) ?? []);
  return configurations.runtime(PLATFORM_ASSET_SCOPE, true, "platform").filter((r) => !installed.has(r.environment.id));
}

/** Secret-free catalogue for one Actor. Order and precedence:
 *  1. personal records of `owner.scope`, custom endpoints only for administrators,
 *     each as `e2b-<40 hex>` derived from the backend identity partition, the
 *     Actor generation and the record fingerprint;
 *  2. platform records not part of the installation, each as `e2b-shared-<40 hex>`
 *     derived from the record fingerprint only, so one pool serves every member;
 *  3. the installed source as `e2b`, all its templates in one pool.
 * The three ID namespaces are disjoint. Listing never creates a resource. */
export function resolveBotEnvironments(
  configurations: Configurations,
  owner: BotEnvironmentOwner,
  actor: BotEnvironmentActor,
  backendIdentity: BotBackendIdentity = defaultBotBackendIdentity,
): BotEnvironmentCatalog {
  const environments: ResolvedBotEnvironment[] = [];
  const seen = new Set<string>();
  const add = (value: ResolvedBotEnvironment) => {
    if (seen.has(value.backendId)) return;
    seen.add(value.backendId);
    environments.push(value);
  };
  for (const record of configurations.runtime(owner.scope, owner.custom)) {
    const fingerprint = botRecordFingerprint(record, "personal");
    const identity = identityOf(backendIdentity, record, actor);
    add({
      source: "personal",
      backendId: "e2b-" + hash([identity, actor.generation, fingerprint]).slice(0, 40),
      fingerprint,
      templates: [{ id: record.environment.templateId, name: record.environment.name }],
      record,
    });
  }
  for (const record of platformBotRecords(configurations)) {
    const fingerprint = botRecordFingerprint(record, "platform");
    add({
      source: "platform",
      backendId: "e2b-shared-" + hash([fingerprint]).slice(0, 40),
      fingerprint,
      templates: [{ id: record.environment.templateId, name: record.environment.name }],
      record,
    });
  }
  const installed = configurations.installedRuntime();
  if (installed?.records.length)
    add({
      source: "installed",
      backendId: "e2b",
      fingerprint: installedBotFingerprint(installed),
      templates: installed.records.map((r) => ({ id: r.environment.templateId, name: r.environment.name })),
    });
  return {
    revision: hash([
      owner.scope,
      owner.custom,
      actor.generation,
      environments.map((e) => [e.source, e.backendId, e.fingerprint]),
    ]),
    environments,
  };
}

/** Worker-side recheck of a Main admission against committed Actor/member
 * truth. Resource checks (`pending=false`) outlive the original request;
 * pending checks also require the live request permit and expiry. */
export class BotEnvironmentAuthority {
  private authority?: WorkspaceActorAuthority;
  private closed = false;
  constructor(private readonly directory: string) {}
  /** Validates and freezes a raw admission, then checks it as pending. */
  admit(raw: WorkspaceActorAdmission): WorkspaceActorAdmission {
    if (this.closed) return deny();
    let access: WorkspaceActorAdmission;
    try {
      access = workspaceAdmission(raw);
    } catch {
      return deny();
    }
    this.owner(access, true);
    return access;
  }
  owner(access: WorkspaceActorAdmission, pending: boolean): BotEnvironmentOwner {
    if (this.closed) return deny();
    this.authority ??= new WorkspaceActorAuthority(this.directory);
    if (!this.authority.current(access, pending)) return deny();
    return { scope: "actor:" + access.actorId, custom: this.authority.administrator(access.actorId) };
  }
  close() {
    this.closed = true;
    this.authority?.close();
  }
}
