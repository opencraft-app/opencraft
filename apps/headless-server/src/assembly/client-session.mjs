import { AppHostServer } from "@opencraft/app-host-server";
import { ThreadAccessSession } from "@opencraft/access-control/thread-access";
import { ServerSpacesSession } from "@opencraft/access-control/server-spaces-session";
import { CHANNELS_HOST_ID } from "@opencraft/appserver-protocol/channels";
import { AgentDriverSession } from "@opencraft/opencraft-daemon/agent-driver-transport";
import { TokenUsageQuerySession } from "@opencraft/opencraft-daemon/token-usage-query-transport";
import { conversationAccessServer, callConversationHost } from "../conversation-execution.mjs";
import { createLateBinding } from "./lifecycle.mjs";

// The Hosts this server runs itself; the others are remote Codex Hosts.
const LOCAL_HOSTS = ["local-codex", "opencraft-server"];

/**
 * Client-session assembly (gateway-split §4.1.1): what a connected client
 * session reaches. The per-connection access sessions (Thread policy, and
 * Server spaces once an Actor signed in, with the first administrator's
 * spaces bootstrap), the App Host server with its logical client routing and
 * the dispatch of each Host id to its transport, and the sessions Web accepts
 * on its App Server, driver, query and Hands sockets.
 *
 * It owns the App Host late binding: installation and workspace-host receive
 * `appHost` before the server exists and read it only after it was bound.
 * Every Host's inner engine transport, and the account, Hands and push
 * layers around it, are Node constructions the composition root supplies as
 * factories; the module decides which Host gets which layers, in which
 * order. Creating it opens nothing. The root calls each step at its original
 * position in startup and the named disposer at its original position in the
 * shutdown order; it resolves without effect before the server exists.
 */
export function assembleClientSession() {
  const appHost = createLateBinding("App Host server");
  let accessServerForHost, createThreadAccessSession;
  return {
    /** The App Host server, bound by `openAppHost`. */
    appHost,
    /**
     * The access session factory for App Host RPC and Web's App Server socket:
     * the Thread policy session, wrapped by the Server spaces session when an
     * Actor signed in. Opens nothing.
     */
    openAccessSessions({
      machineIdentity,
      conversationExecution,
      threadAccess,
      threadNotes,
      serverSpaces,
      membership,
      actorStore,
      instanceAccess,
      identity,
      anonymousHandoff,
    }) {
      accessServerForHost = (hostId, threadId) =>
        conversationAccessServer(conversationExecution, machineIdentity.machineId, hostId, threadId);
      const createThreadPolicySession = (hostId, context, emit) =>
        new ThreadAccessSession(
          threadAccess,
          (threadId, serverId, method) => {
            if (method === "opencraft/token-usage/query" && serverId === undefined)
              return `server:${machineIdentity.machineId}:codex`;
            if (serverId?.startsWith("server:")) return serverId;
            const target = serverId === "local-codex" || serverId === "opencraft-server" ? serverId : hostId;
            return accessServerForHost(target, threadId);
          },
          context.actorContext,
          emit,
          async (threadId) => {
            if (
              context.actorContext &&
              identity?.isThreadCreator &&
              (await identity.isThreadCreator(hostId, threadId, context, (method, params) =>
                callConversationHost(appHost.current(), { hostId, threadId: "" }, "thread-creator", method, params),
              ))
            )
              threadAccess.created(accessServerForHost(hostId, threadId), threadId, context.actorContext);
          },
          () => {
            context.resourceOwner?.assertCurrent();
            if (
              context.actorContext &&
              (!actorStore.isCurrent(context.actorContext) ||
                (instanceAccess && !instanceAccess.admitsActor(context.actorContext.actorId)))
            )
              throw new Error("Conversation access expired");
          },
          threadNotes,
          false,
          () => LOCAL_HOSTS.includes(hostId) && anonymousHandoff(),
        );
      createThreadAccessSession = (hostId, context, emit) => {
        // Anonymous installations retain their legacy path until an explicit human
        // administrator initializes collaboration membership.
        if (!context.actorContext) return createThreadPolicySession(hostId, context, emit);
        const session = new ServerSpacesSession(
          serverSpaces,
          context.actorContext,
          (id) => conversationExecution.serverForHost(hostId, id),
          emit,
          createThreadPolicySession(hostId, context, emit),
          (serverId, threadId) => threadAccess.allows(serverId, threadId, context.actorContext),
          () => {
            context.resourceOwner?.assertCurrent();
            if (
              !actorStore.isCurrent(context.actorContext) ||
              (instanceAccess && !instanceAccess.admitsActor(context.actorContext.actorId))
            )
              throw new Error("Server access expired");
          },
          (threadId) =>
            callConversationHost(appHost.current(), { hostId, threadId: "" }, "server-space-history", "thread/read", {
              threadId,
              includeTurns: false,
            }),
        );
        return {
          async receive(frame) {
            if (
              !serverSpaces.initialized &&
              instanceAccess?.admitsActor(context.actorContext.actorId) &&
              membership.actorMembership(context.actorContext.actorId)?.role === "admin"
            )
              await serverSpaces.bootstrap(context.actorContext.actorId);
            return session.receive(frame);
          },
          rewrite: (frame) => session.rewrite(frame),
          prepare: (frame) => session.prepare(frame),
          project: (frame) => session.project(frame),
          close: () => session.close(),
        };
      };
      return { accessServerForHost, createThreadAccessSession };
    },
    /**
     * Constructs and binds the App Host server. Each Host id selects its inner
     * transport: IM channels as is; the server's own engine, a configured or
     * saved SSH Codex Host, or the local Codex Host under the model policy,
     * the workspace-host execution scope, the model gateway settings (local
     * Hosts), the workspace-host resource scope and the push observation
     * (local Hosts); any other id fails when its Host starts.
     */
    openAppHost({ transports, layers, hostTransports, remoteServers, sshManagement }) {
      return appHost.bind(
        new AppHostServer({
          createRpcAccessSession: createThreadAccessSession,
          logicalClientRouting: true,
          physicalHostLifetime: "server",
          createTransport(hostId) {
            if (hostId === CHANNELS_HOST_ID) return transports.channels();
            const transport = layers.modelPolicy(
              (() => {
                if (hostId === "opencraft-server") return transports.server();
                const remote = remoteServers.get(hostId);
                if (remote) return transports.remoteCodex(remote, hostId);
                if (hostId.startsWith("ssh:"))
                  return transports.remoteCodex(sshManagement.get().store.binding(hostId), hostId);
                if (hostId !== "local-codex") throw new Error(`Unknown server Host ${hostId}`);
                return transports.localCodex(hostId);
              })(),
              hostId === "opencraft-server" ? "dsh" : "codex",
            );
            let scopedTransport = hostTransports.scopeExecution(hostId, transport);
            // Read for every Host, as before: an invalid configured gateway path fails each Host's start.
            const gatewaySettings = layers.modelGatewaySettings();
            if (gatewaySettings && LOCAL_HOSTS.includes(hostId)) scopedTransport = gatewaySettings(scopedTransport);
            scopedTransport = hostTransports.scopeResources(hostId, scopedTransport);
            return LOCAL_HOSTS.includes(hostId) ? layers.pushObservation(scopedTransport, hostId) : scopedTransport;
          },
        }),
      );
    },
    /**
     * The sessions Web accepts for the server's own Host: App Server access,
     * the agent driver, token usage queries, and (only with a Hands terminal
     * or file owner) one terminal and file session.
     */
    openWebSessions({
      actorCollaboration,
      conversationExecution,
      signExecutionCli,
      operator,
      usageQueries,
      actorStore,
      terminalService,
      terminalScope,
      fileSystem,
      resourceAuthority,
      selectHostTerminalService,
      selectHostFiles,
      sessions,
    }) {
      const hostId = "opencraft-server";
      return {
        createAppServerAccessSession: (context, emit) => createThreadAccessSession(hostId, context, emit),
        createAppServerDriverSession: (emit) =>
          new AgentDriverSession(
            actorCollaboration,
            (threadId) => conversationExecution.serverForHost(hostId, threadId),
            emit,
            signExecutionCli,
            operator.context,
          ),
        createAppServerQuerySession: (emit) =>
          new TokenUsageQuerySession(usageQueries, emit, (actorId) => actorStore.get(actorId)),
        createTerminalSession:
          terminalService || fileSystem
            ? (emit) => {
                const hands = [
                  ...(terminalService
                    ? [
                        sessions.terminal(
                          terminalService(hostId),
                          terminalScope(hostId),
                          hostId,
                          selectHostTerminalService
                            ? (scope, context, local) => selectHostTerminalService(hostId, scope, context, local)
                            : undefined,
                        ),
                      ]
                    : []),
                  ...(fileSystem
                    ? [
                        sessions.files(
                          fileSystem,
                          resourceAuthority,
                          selectHostFiles
                            ? (context, params, local) => selectHostFiles(hostId, context, params, local)
                            : undefined,
                        ),
                      ]
                    : []),
                ];
                for (const session of hands) session.subscribeMessage(emit);
                return {
                  connect: () => Promise.all(hands.map((session) => session.connect())),
                  close: () => {
                    for (const session of hands) session.close();
                  },
                  project: (frame) =>
                    hands.reduce((value, session) => (value === null ? null : session.project(value)), frame),
                  receive: async (frame, context) => {
                    for (const session of hands) if (await session.receive(frame, context)) return true;
                    return false;
                  },
                };
              }
            : null,
      };
    },
    /** Shutdown step 7: after the personal assistant, before the server's Codex Engine Host. */
    closeAppHost: () => appHost.current()?.close(),
  };
}
