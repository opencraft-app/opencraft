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

/** A Durable Object namespace binding, as the entry Worker addresses the installation's object. */
export interface InstallationCoreNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
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

/** `ctx` of a WorkspaceHost object: storage with the object's single alarm, and its container. */
export interface WorkspaceHostState {
  readonly storage: InstallationCoreStorage;
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
  /** Name of the workspace image in `ctx.container.images`; default `workspace`. */
  readonly OPENCRAFT_WORKSPACE_IMAGE?: string;
  /** Idle policy (workspace-host-split §3.7.2): milliseconds, or `resident`; default 15 minutes. */
  readonly OPENCRAFT_WORKSPACE_IDLE?: string;
  /** Engines of the workspace's Engine Host, comma-separated; default `pi`. */
  readonly OPENCRAFT_WORKSPACE_ENGINES?: string;
  /** Interpreter in the image for the shared broker and endpoint relay; default `/usr/bin/python3`. */
  readonly OPENCRAFT_WORKSPACE_PYTHON?: string;
}

/** Everything the deployment's entry Worker routes with. */
export interface DeploymentRoutingEnv extends InstallationCoreEnv {
  /** One WorkspaceHost object per workspace id. */
  readonly WORKSPACE_HOST: WorkspaceHostNamespace;
}
