// Structural subset of the Workers runtime this deployment assembly consumes
// (the Durable Object state and the bindings it is configured with). Declared
// here, as @opencraft/storage-cloudflare declares its storage subset, so the
// assembly imports no `cloudflare:*` module and no global Workers types.
import type { DurableObjectStorage } from "@opencraft/storage-cloudflare/bindings";

/** `ctx.storage` of a SQLite-backed Durable Object, with the object's single alarm. */
export interface InstallationCoreStorage extends DurableObjectStorage {
  setAlarm(scheduledTime: number): Promise<void>;
  deleteAlarm(): Promise<void>;
  getAlarm(): Promise<number | null>;
}

/** `ctx` of a Durable Object. */
export interface InstallationCoreState {
  readonly storage: InstallationCoreStorage;
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
  /** Resets the object: its memory is dropped and the next event constructs it again. */
  abort(reason?: string): void;
}

/** A Durable Object namespace binding, as the entry Worker (and one object another) addresses an object. */
export interface InstallationCoreNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
}
/** The account's object namespace; the same structural binding. */
export type AccountCoreNamespace = InstallationCoreNamespace;

/** `ctx` of the AccountCore object; its alarm wakes the account pool's renewal schedule. */
export interface AccountCoreState {
  readonly storage: InstallationCoreStorage;
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
  /** Resets the object: its memory is dropped and the next event constructs it again. */
  abort(reason?: string): void;
}

/** The bindings the AccountCore object reads (deploy/cloudflare/wrangler.installation-core.jsonc). */
export interface AccountCoreEnv {
  /** The installation's object: the account asks it who may use an account route. */
  readonly INSTALLATION_CORE: InstallationCoreNamespace;
  /**
   * The key that seals model credentials in the object's storage (a secret,
   * `<id>.<base64url of 32 random bytes>`). Without a valid key the object
   * stays closed; it never stores a credential unsealed.
   */
  readonly OPENCRAFT_ACCOUNT_SEALING_KEY?: string;
  /**
   * The account maintenance executor (a service binding to the maintenance
   * container's front door), which runs a provider's OAuth renewal for the
   * account pool (`@opencraft/account-pool-host/renewal`). Absent: renewals
   * fail as unavailable and are retried; selection still serves valid credentials.
   */
  readonly ACCOUNT_MAINTENANCE?: { fetch(request: Request): Promise<Response> };
}

/** Everything the deployment's entry Worker is bound to. */
export interface DeploymentEnv extends InstallationCoreEnv, AccountCoreEnv {
  /** The installation's single AccountCore object. */
  readonly ACCOUNT_CORE: AccountCoreNamespace;
}

/**
 * The deployment's bindings (deploy/cloudflare/wrangler.installation-core.jsonc).
 * Names are the installation's, not the platform's.
 */
export interface InstallationCoreEnv {
  /** The installation's single InstallationCore object. */
  readonly INSTALLATION_CORE: InstallationCoreNamespace;
  /**
   * Human login configuration as the operator installed it (JSON text of
   * `{ origin, local, oidc }`, validated like the Node configuration file);
   * absent when the deployment has no Human login.
   */
  readonly OPENCRAFT_HUMAN_AUTH?: string;
  /** The operator's one-time setup proof (a secret); absent once no setup is offered. */
  readonly OPENCRAFT_SETUP_TOKEN?: string;
  /** The installation's display name; absent keeps the default. */
  readonly OPENCRAFT_MACHINE_NAME?: string;
}
