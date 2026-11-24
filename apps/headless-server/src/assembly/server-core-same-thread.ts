// A Server core owner on the authorizer's own thread (runtime-neutral;
// gateway-split §4.1.1 "根输入端口", cloudflare-deployment §5.3).
//
// The installation module talks to its core SQL owner through one shape: the
// migrated database the projections read, and `call`, the owner methods that
// commit. The Node root opens that owner in a Worker (`openServerCoreOwner`);
// an owner whose SQL database is already exclusive and on this thread (a
// Durable Object) builds the same shape here, over the same storage methods
// and the same domain composition the Node owner Worker serves. Calls keep the
// Worker's contract: FIFO, one at a time, arguments and results cloned, and
// each runs only after the previous reply was delivered to its issuer, which
// is what the same-thread commit fence requires (a deferred fence answer is a
// denial on one thread).
import type { CommitFence } from "@opencraft/access-control/commit-fence";
import type { IdentityWriteOwner } from "@opencraft/access-control/identity-writes";
import type { ServerCoreStorage } from "@opencraft/storage-node/server-owner";
import type { SqlDatabase } from "@opencraft/sql";
import { serverCoreStorageMethods } from "@opencraft/storage-node/server-core-methods";
import type { ServerDatabaseHandle } from "@opencraft/storage-node/server-repository";
import { serverCoreDomains } from "../server-core-domains.mjs";

type OwnerMethod = (...args: never[]) => unknown;

/** The core SQL owner as the installation module consumes it, on the authorizer's thread. */
export interface SameThreadServerCore<Contract = unknown> extends ServerDatabaseHandle {
  readonly database: SqlDatabase;
  readonly contract: Contract;
  /**
   * Owner methods by name, each resolving after it ran; unknown names reject
   * as the Worker owner does. Typed as the Node owner's calls.
   */
  readonly call: ServerCoreStorage<IdentityWriteOwner>["call"];
  /** A same-thread owner is never lost apart from its object; listeners are kept for the port's shape only. */
  onUnavailable(listener: (error: Error) => void): () => void;
  /** Refuses later calls, drains the queue, then closes the domains. Idempotent. */
  close(): Promise<void>;
}

const macrotask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

export function sameThreadServerCore<Contract>(
  handle: ServerDatabaseHandle & { readonly contract: Contract },
  { identityFence }: { readonly identityFence: CommitFence },
): SameThreadServerCore<Contract> {
  const domains = serverCoreDomains(handle, { identityFence });
  // The Node owner's precedence: domains first, the storage methods over them.
  const methods: Readonly<Record<string, OwnerMethod>> = {
    ...domains.methods,
    ...serverCoreStorageMethods(handle.database),
  };
  let tail: Promise<unknown> = Promise.resolve();
  let closed = false;
  let closing: Promise<void> | undefined;
  const issue = (name: string, args: unknown[]): Promise<never> => {
    // Calls issued before close still run, in order, as the Worker owner's queue does.
    if (closed) return Promise.reject(new Error("Server core owner is closed"));
    const run = tail.then(macrotask).then(async () => {
      const method = Object.hasOwn(methods, name) ? methods[name] : undefined;
      if (!method) throw new Error(`Unknown owner method ${name}`);
      const value = await (method as (...values: unknown[]) => unknown)(...structuredClone(args));
      return structuredClone(value) as never;
    });
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
  const call = new Proxy({} as SameThreadServerCore["call"], {
    get: (_target, name) =>
      typeof name === "string" && name !== "then" ? (...args: unknown[]) => issue(name, args) : undefined,
  });
  return {
    database: handle.database,
    outcome: handle.outcome,
    contract: handle.contract,
    call,
    onUnavailable: () => () => {},
    close: () =>
      (closing ??= (async () => {
        closed = true;
        await tail;
        await domains.close();
      })()),
  };
}
