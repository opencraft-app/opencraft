// Structural subset of the Workers runtime this deployment assembly consumes
// (the Durable Object state and the bindings it is configured with). Declared
// here, as @opencraft/storage-cloudflare declares its storage subset, so the
// assembly imports no `cloudflare:*` module and no global Workers types.
import type { DurableObjectStorage } from "@opencraft/storage-cloudflare/bindings";
import type { DurableObjectContainer } from "@opencraft/sandbox-cloudflare/bindings";

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
  /** One-time model document and credential seed for a deployment without a model document. */
  readonly OPENCRAFT_ACCOUNT_MODEL_BOOTSTRAP?: string;
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
  readonly WORKSPACE_HOST?: WorkspaceHostNamespace;
  /** Opt-in workspace for projectless Codex Thread creation. */
  readonly OPENCRAFT_WORKSPACE_CODEX_DEFAULT?: string;
  /** Routes projectless creation to an Actor's own workspace. Existing placements remain authoritative. */
  readonly OPENCRAFT_WORKSPACE_CODEX_ISOLATE_ACTORS?: string;
  /** Requires a Hands image exposing the scoped file owner endpoint. */
  readonly OPENCRAFT_WORKSPACE_CODEX_FILES?: string;
  /** Enable the native project catalog within isolated Codex workspaces. */
  readonly OPENCRAFT_WORKSPACE_CODEX_PROJECTS?: string;
  readonly OPENCRAFT_WORKSPACE_CODEX_TURNS?: string;
  /** Lets Client DO advertise on-demand archived history from workspace snapshots. */
  readonly OPENCRAFT_WORKSPACE_CODEX_SNAPSHOTS?: string;
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

/** `ctx` of a WorkspaceHost object: storage with the object's single alarm, and its container. */
export interface WorkspaceHostState {
  readonly storage: InstallationCoreStorage;
  readonly exports?: {
    WorkspaceCodexModelEgress?(options: { props: { workspace: string; nonce: string } }): {
      fetch(request: Request): Promise<Response>;
    };
  };
  /** `ctx.container` when the class is bound to a container application; absent otherwise. */
  readonly container?: DurableObjectContainer;
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
  waitUntil(promise: Promise<unknown>): void;
  /** Resets the object: its memory is dropped and the next event constructs it again. */
  abort(reason?: string): void;
}

/** The workspaces' object namespace: one object per workspace id. */
export type WorkspaceHostNamespace = InstallationCoreNamespace;

/**
 * The bindings a WorkspaceHost object reads (deploy/cloudflare/wrangler.installation-core.jsonc).
 * Non-secret configuration only: the container holds no credential and neither do these.
 */
export interface WorkspaceHostEnv {
  readonly ACCOUNT_CORE?: AccountCoreNamespace;
  readonly OPENCRAFT_WORKSPACE_CODEX_FILES?: string;
  readonly OPENCRAFT_WORKSPACE_CODEX_PROJECTS?: string;
  readonly OPENCRAFT_WORKSPACE_CODEX_TURNS?: string;
  /** Requires an image whose startup supports restoring captured filesystems. */
  readonly OPENCRAFT_WORKSPACE_CODEX_SNAPSHOTS?: string;
  /** Start the packaged Bridge Host and require its private endpoint on operator wake. */
  readonly OPENCRAFT_WORKSPACE_CODEX_BRIDGE_ENDPOINT?: string;
  readonly INSTALLATION_CORE?: InstallationCoreNamespace;
  /** Name of the workspace image in `ctx.container.images`; default `workspace`. */
  readonly OPENCRAFT_WORKSPACE_IMAGE?: string;
  /** Idle policy (workspace-host-split §3.7.2): milliseconds, or `resident`; default 15 minutes. */
  readonly OPENCRAFT_WORKSPACE_IDLE?: string;
  /**
   * Engines of the workspace, comma-separated; default `pi`. An image with
   * the separate Codex AppServer can add `codex` beside its Engine Host.
   */
  readonly OPENCRAFT_WORKSPACE_ENGINES?: string;
  /** Private HTTP intercept origin and configured AccountCore provider identity. */
  readonly OPENCRAFT_WORKSPACE_CODEX_EGRESS_ORIGIN?: string;
  readonly OPENCRAFT_WORKSPACE_CODEX_EGRESS_PROVIDER?: string;
  /** Interpreter in the image for the shared broker and endpoint relay; default `/usr/bin/python3`. */
  readonly OPENCRAFT_WORKSPACE_PYTHON?: string;
  /** Non-root numeric uid:gid of the workspace image's broker processes. */
  readonly OPENCRAFT_WORKSPACE_USER?: string;
}

/** Everything the deployment's entry Worker routes with. */
export interface DeploymentRoutingEnv extends InstallationCoreEnv {
  /** One WorkspaceHost object per workspace id. */
  readonly WORKSPACE_HOST: WorkspaceHostNamespace;
}
