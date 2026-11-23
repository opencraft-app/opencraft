import type { SqlDatabase } from "@opencraft/sql";
import type { ActorContext } from "@opencraft/identity-core/actors";
import type { ServerSpaceCommand } from "@opencraft/appserver-protocol/server-spaces";
import { ServerSpacesLedger, type SpaceProjection } from "./server-spaces-ledger.js";

/** Who becomes the first space owner when the ledger has none yet. */
export interface ServerSpacesBootstrap {
  readonly ownerActorId?: string;
  readonly members?: readonly string[];
  /** Adopt the installation's enabled human administrator and members. */
  readonly bootstrapInstance?: boolean;
}
type ServerThreadRef = { serverId: string; threadId: string };
/** One request to the Server space ledger, as `ServerSpacesRuntime` sends it. */
export type ServerSpacesRequest =
  | { method: "inherit"; parent: ServerThreadRef; child: ServerThreadRef }
  | { method: "bootstrap"; ownerActorId: string; members?: readonly string[] }
  | {
      method: "legacy";
      context: ActorContext;
      engineServerId: string;
      threads: readonly { id: string; createdAt: number }[];
    }
  | { method: "assign"; context: ActorContext; engineServerId: string; threadId: string; spaceId: string }
  | { method: "command"; context: ActorContext; command: ServerSpaceCommand };
const METHODS: Readonly<Record<ServerSpacesRequest["method"], true>> = {
  inherit: true,
  bootstrap: true,
  legacy: true,
  assign: true,
  command: true,
};
/**
 * Turns a message received by an owner entry into a request, or `undefined`
 * for an unknown method. Only the method name is checked; the fields are
 * trusted as typed because the only sender is this package's
 * `ServerSpacesRuntime`, inside the same process, over a Worker port or the
 * Server core owner port that no remote party can write to. The ledger still
 * validates every command and context it receives.
 */
function serverSpacesRequest(message: unknown): ServerSpacesRequest | undefined {
  if (typeof message !== "object" || message === null || !("method" in message)) return undefined;
  const { method } = message;
  return typeof method === "string" && Object.hasOwn(METHODS, method) ? (message as ServerSpacesRequest) : undefined;
}
export type ServerSpacesReply =
  { result: unknown; projection?: SpaceProjection } | { error: { rpcCode: number; reason: string; message: string } };

/**
 * The Server space ledger over one connection. It runs only where that
 * connection is owned: the Server core owner Worker (Headless) or the
 * standalone server-spaces Worker. Each mutation commits in its own
 * transaction before the reply carries the new projection.
 */
export function serverSpacesDomain(db: SqlDatabase, bootstrap: ServerSpacesBootstrap, localContext?: ActorContext) {
  const ledger = new ServerSpacesLedger(db);
  if (localContext) ledger.bootstrap(localContext.actorId);
  else if (bootstrap.ownerActorId) ledger.bootstrap(bootstrap.ownerActorId, bootstrap.members ?? []);
  else if (bootstrap.bootstrapInstance) {
    const members = db
      .prepare(
        "SELECT m.actor_id,m.role FROM actor_members m JOIN actors a ON a.id=m.actor_id WHERE m.enabled=1 AND a.enabled=1 AND a.kind='human' ORDER BY m.actor_id",
      )
      .all();
    const administrator = members.find((member) => member.role === "admin");
    if (administrator)
      ledger.bootstrap(
        String(administrator.actor_id),
        members.map((member) => String(member.actor_id)),
      );
  }
  const domain = {
    projection: () => ledger.projection(),
    /** Ledger errors become the reply's `error`; nothing partial is committed. */
    execute(request: ServerSpacesRequest): ServerSpacesReply {
      try {
        const execute = () =>
          request.method === "inherit"
            ? ledger.inherit(
                request.parent.serverId,
                request.parent.threadId,
                request.child.serverId,
                request.child.threadId,
              )
            : request.method === "bootstrap"
              ? ledger.bootstrap(request.ownerActorId, request.members ?? [])
              : request.method === "legacy"
                ? ledger.adoptLegacy(localContext ?? request.context, request.engineServerId, request.threads)
                : request.method === "assign"
                  ? ledger.assign(
                      localContext ?? request.context,
                      request.engineServerId,
                      request.threadId,
                      request.spaceId,
                    )
                  : ledger.command(localContext ?? request.context, request.command);
        const mutated =
          ["assign", "legacy", "bootstrap", "inherit"].includes(request.method) ||
          (request.method === "command" &&
            ["create", "invite", "join", "remove", "contact", "addBot"].includes(request.command?.action));
        const result = mutated ? db.transaction(execute) : execute();
        return {
          result,
          ...(mutated && (request.method !== "legacy" || result === true) ? { projection: ledger.projection() } : {}),
        };
      } catch (error) {
        const e = error as Error & { rpcCode?: number; reason?: string };
        return {
          error: {
            rpcCode: e.rpcCode ?? -32004,
            reason: e.reason ?? "unavailable",
            message: "Server action unavailable",
          },
        };
      }
    },
    /** Owner entry: an unknown method gets the ledger's invalid-input reply. */
    receive(message: unknown): ServerSpacesReply {
      const request = serverSpacesRequest(message);
      return request
        ? domain.execute(request)
        : { error: { rpcCode: -32602, reason: "invalid", message: "Server action unavailable" } };
    },
  };
  return domain;
}

/**
 * Methods the Server core owner Worker serves for `ServerSpacesRuntime` over
 * its owner connection, in FIFO order with every other owner domain. The
 * ledger opens (and bootstraps) when the network thread first asks, so the
 * bootstrap sees the members committed before that point.
 */
export function serverSpacesOwnerMethods(owner: { readonly database: SqlDatabase }) {
  let domain: ReturnType<typeof serverSpacesDomain> | undefined;
  return {
    methods: {
      serverSpacesOpen: (bootstrap: ServerSpacesBootstrap = {}) => ({
        projection: (domain ??= serverSpacesDomain(owner.database, bootstrap)).projection(),
      }),
      // Owner entry for `ServerSpacesRuntime` on this in-process owner port.
      serverSpaces: (message: unknown) => {
        if (!domain) throw new Error("Server spaces are not open");
        return domain.receive(message);
      },
    },
  };
}
