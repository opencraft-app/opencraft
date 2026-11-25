/**
 * Structural subset of the workerd Durable Object Container API (`this.ctx.container`)
 * that this backend consumes. Deployment assembly passes the real `ctx.container`; the
 * conformance tests pass an in-process double. Shapes follow the Cloudflare Workers
 * runtime ("Durable Object Container API"); only what the backend calls is declared, so
 * no Workers type package is needed.
 */

/** `start({ instance })`: a named size or a custom size (memory in MiB, disk in MB). */
export type ContainerInstance =
  | "lite"
  | "standard-1"
  | "standard-2"
  | "standard-3"
  | "standard-4"
  | { readonly vcpu: number; readonly memoryMib: number; readonly diskMb: number };

export type ContainerStartOptions = ({
  /** Digest-pinned reference (a value of `images`); `durable_object` scheduling policy. */
  readonly image: string;
  readonly containerSnapshot?: never;
} | {
  readonly containerSnapshot: { readonly id: string };
  readonly image?: never;
}) & {
  readonly enableInternet: boolean;
  readonly instance?: ContainerInstance;
  /** Up to 10 labels (names 1–16 bytes, values ≤ 64 bytes), returned by `inspect()`. */
  readonly labels?: Readonly<Record<string, string>>;
  /** Main-process environment. Processes started by `exec()` do not inherit it (except PATH). */
  readonly env?: Readonly<Record<string, string>>;
  readonly entrypoint?: readonly string[];
};

export interface ContainerSnapshot {
  readonly id: string;
  readonly size: number;
  readonly name?: string;
}

export interface ContainerInfo {
  readonly image: string;
  readonly labels: Readonly<Record<string, string>>;
}

export interface ContainerExecOptions {
  readonly stdin?: "pipe";
  readonly stdout?: "pipe" | "ignore";
  readonly stderr?: "pipe" | "ignore" | "combined";
  readonly cwd?: string;
  /** Not inherited from `start()` or the image, except PATH. */
  readonly env?: Readonly<Record<string, string>>;
  /** Numeric `uid:gid`. */
  readonly user?: string;
  readonly signal?: AbortSignal;
  readonly pty?: boolean | { readonly cols?: number; readonly rows?: number };
}

export interface ContainerExecProcess {
  readonly stdin?: WritableStream<Uint8Array> | null;
  readonly stdout?: ReadableStream<Uint8Array> | null;
  readonly stderr?: ReadableStream<Uint8Array> | null;
  readonly pid: number;
  /** Resolves (a nonzero code does not reject) when the process exits. */
  readonly exitCode: Promise<number>;
  /** Signals only this process, not its descendants. Signalling a process that already
   * exited raises an uncaught internal error in the Durable Object: never do that. */
  kill(signal?: number): void;
}

/** `this.ctx.container` of a Durable Object class with a container binding. */
export interface DurableObjectContainer {
  readonly running: boolean;
  /** `durable_object` scheduling policy: digest-pinned image references by name. */
  readonly images?: Readonly<Record<string, string>>;
  /** Registers a private HTTP destination for the lifetime of the running container. */
  interceptOutboundHttp?(host: string, handler: { fetch(request: Request): Promise<Response> }): Promise<void>;
  /** Returns once the options are validated; later failures surface in `monitor()`. */
  start(options: ContainerStartOptions): void;
  /** Optional in the port so deployments without the captured capability stay compatible. */
  snapshotContainer?(options: { readonly name?: string }): Promise<ContainerSnapshot>;
  /** `null` when no container is running. */
  inspect(): Promise<ContainerInfo | null>;
  /** Waits for a container that is still starting; throws when none is running. */
  exec(command: string[], options?: ContainerExecOptions): Promise<ContainerExecProcess>;
  /** Settles when the container stops (also for one that stopped before the call):
   * resolves for exit code 0 or a reasonless `destroy()`, rejects with an
   * `exitCode`-bearing error otherwise. Not carried over a Durable Object restart. */
  monitor(): Promise<void>;
  /** Stops the container immediately. */
  destroy(reason?: unknown): Promise<void>;
  /** Per Durable Object instance; not retained across Durable Object restarts. */
  setInactivityTimeout(durationMs: number): Promise<void>;
}
