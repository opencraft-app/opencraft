import { TransparentProtocolMapperService } from "../../src/services/transparent-protocol-mapper.ts";
import { TransparentRuntimeLocatorService } from "../../src/services/transparent-runtime-locator.ts";
import { TransparentRuntimeAccessService } from "../../src/services/transparent-runtime-access.ts";
import {
  hydrateTransparentBindings,
  TransparentThreadBindingService,
} from "../../src/services/transparent-thread-binding.ts";
import { TransparentBackendChannelService } from "../../src/services/transparent-backend-channel.ts";
import { TransparentBackendProjectionService } from "../../src/services/transparent-backend-projection.ts";
import {
  TransparentBackendMessageCoordinatorService,
} from "../../src/services/transparent-backend-message-coordinator.ts";
import {
  TransparentBackendSessionService,
} from "../../src/services/transparent-backend-session.ts";
import {
  TransparentInternalResponseCoordinatorService,
} from "../../src/services/transparent-internal-response-coordinator.ts";
import {
  TransparentBackendOutboundService,
} from "../../src/services/transparent-backend-outbound.ts";
import {
  TransparentForwardedResponseService,
} from "../../src/services/transparent-forwarded-response.ts";
import { TransparentBackendIngressService } from "../../src/services/transparent-backend-ingress.ts";
import { TransparentSubscriptionService } from "../../src/services/transparent-subscription.ts";

function typedBinding(service) {
  const current = service.ctx.transparentThreadBinding;
  if (typeof current?.setBinding === "function") return current;
  const binding = Object.assign(Object.create(TransparentThreadBindingService.prototype), {
    bindings: current?.bindings ?? service.bindings ?? new Map(),
    runtimeHints: current?.runtimeHints ?? service.runtimeHints ?? new Map(),
    reverseBindings: current?.reverseBindings ?? service.reverseBindings ?? new Map(),
  });
  const host = {
    principalId: "test:principal",
    policyStore: { get: () => null, set: () => {} },
    artifacts: { current: () => null, values: () => [] },
    threads: {
      find: (threadId) => service.ctx.threadManager?.find?.(threadId) ?? null,
      isTransparentCodex: (threadId) => (
        service.ctx.threadManager?.isTransparentCodex?.(threadId) ?? false
      ),
      ownerOf: (threadId) => service.ctx.threadManager?.ownerOf?.(threadId) ?? null,
    },
    workspaceViews: { recordFor: () => null },
    users: { find: () => null, list: () => [] },
    credentials: { resolveUser: () => null },
  };
  binding.host = () => host;
  hydrateTransparentBindings(binding, host);
  service.ctx.transparentThreadBinding = binding;
  service.bindings = binding.bindings;
  service.runtimeHints = binding.runtimeHints;
  service.reverseBindings = binding.reverseBindings;
  return binding;
}

function localExecutionFilesystem(source = {}) {
  return {
    physicalRoot: source.physicalRoot ?? "/run/hypernode-test-user",
    enabled: source.enabled,
    mount: source.mount,
    normalize: source.normalize?.bind(source) ?? ((path) => path),
    owns: source.owns?.bind(source) ?? (() => false),
    toPhysical: source.toPhysical?.bind(source) ?? ((path) => path),
    toVirtual: source.toVirtual?.bind(source) ?? ((path) => path),
    ensureWorkingDirectory: source.ensureWorkingDirectory?.bind(source) ?? ((path) => path),
    spawnAppServer: source.spawnAppServer?.bind(source) ?? (() => {}),
    spawnThreadRuntime: source.spawnThreadRuntime?.bind(source) ?? (() => {}),
    send: source.send?.bind(source) ?? (() => {}),
    drain: source.drain?.bind(source) ?? (() => ({})),
    kill: source.kill?.bind(source) ?? (() => {}),
    terminateThreadRuntime: source.terminateThreadRuntime?.bind(source) ?? (() => {}),
  };
}

/** Attach the typed Runtime/Workspace port to façade tests that bypass Cordis. */
export function attachTransparentRuntimeAccess(service) {
  if (service.ctx.transparentRuntimeAccess) return service.ctx.transparentRuntimeAccess;
  service.ctx.transparentProtocolMapper ??= {
    toInner: (message) => message,
    toOuter: (message) => message,
    toPhysical: (path) => path,
    toVirtual: (path) => path,
  };
  service.ctx.transparentBackendRegistry ??= {
    backends: service.backends ?? new Map(),
    connections: service.connections ?? new Map(),
  };
  service.ctx.transparentRuntimeLocator ??= Object.assign(
    Object.create(TransparentRuntimeLocatorService.prototype),
    { ctx: service.ctx },
  );
  const workspace = {
    isWorkspaceFilesystem: (filesystem) => {
      const configured = service.ctx.runtimeWorkspace;
      if (typeof configured?.isWorkspaceFilesystem === "function") {
        return configured.isWorkspaceFilesystem(filesystem);
      }
      return Boolean(service.ctx.workspaceFilesystem) &&
        filesystem === service.ctx.workspaceFilesystem;
    },
    defaultFilesystem: (local) => {
      const configured = service.ctx.runtimeWorkspace;
      if (typeof configured?.defaultFilesystem === "function") {
        return configured.defaultFilesystem(local);
      }
      return service.ctx.workspaceFilesystem?.enabled === true
        ? service.ctx.workspaceFilesystem
        : local;
    },
    filesystemForCwd: (cwd, local) => {
      const configured = service.ctx.runtimeWorkspace;
      if (typeof configured?.filesystemForCwd === "function") {
        return configured.filesystemForCwd(cwd, local);
      }
      if (cwd && service.ctx.workspaceFilesystem?.owns?.(cwd)) {
        return service.ctx.workspaceFilesystem;
      }
      return cwd && local.owns(cwd) ? local : null;
    },
    filesystemForRealm: (realm, local) => {
      const configured = service.ctx.runtimeWorkspace;
      if (typeof configured?.filesystemForRealm === "function") {
        return configured.filesystemForRealm(realm, local);
      }
      return realm === "workspace" && service.ctx.workspaceFilesystem
        ? service.ctx.workspaceFilesystem
        : local;
    },
  };
  const access = Object.assign(Object.create(TransparentRuntimeAccessService.prototype), {
    ctx: {
      runtimeWorkspace: workspace,
      transparentProtocolMapper: service.ctx.transparentProtocolMapper,
      transparentRuntimeLocator: service.ctx.transparentRuntimeLocator,
    },
    initializedFilesystem: null,
  });
  access.initialize(localExecutionFilesystem(service.ctx.virtualFilesystem));
  service.ctx.transparentRuntimeAccess = access;
  return access;
}

/**
 * Unit tests that instantiate the legacy façade without Cordis must still
 * supply the same required mapper dependency as production.
 */
export function attachTransparentBackendChannel(service) {
  service.ctx.transparentBackendIngress ??= Object.create(
    TransparentBackendIngressService.prototype,
  );
  service.ctx.transparentSubscription ??= Object.assign(
    Object.create(TransparentSubscriptionService.prototype),
    {
      threadSubscribers: service.threadSubscribers ?? new Map(),
      catalogBroadcasts: service.catalogBroadcasts ?? new Map(),
    },
  );
  if (service.threadSubscribers instanceof Map) {
    service.ctx.transparentSubscription.threadSubscribers = service.threadSubscribers;
  }
  if (service.catalogBroadcasts instanceof Map) {
    service.ctx.transparentSubscription.catalogBroadcasts = service.catalogBroadcasts;
  }
  service.ctx.appServer ??= {};
  service.ctx.appServer.send ??= (connection, message, sensitive = false) =>
    connection.socket.send(message, sensitive);
  service.ctx.appServer.broadcastNotification ??= () => {};
  service.ctx.threadExecution ??= {};
  service.ctx.threadExecution.table ??= {};
  service.ctx.threadExecution.table.get ??= () => null;
  service.ctx.threadExecution.table.runtimeAuthority ??= () => null;
  service.ctx.threadExecution.table.latestEpoch ??= () => null;
  service.ctx.transparentBackendChannel = Object.assign(
    Object.create(TransparentBackendChannelService.prototype),
    { ctx: service.ctx, sequence: 0 },
  );
  attachTransparentRuntimeAccess(service);
  attachTransparentBackendMessageCoordinator(service);
  return service.ctx.transparentBackendChannel;
}

export function attachTransparentBackendMessageCoordinator(service) {
  service.ctx.codexRuntimeAdapter ??= { observe: () => false };
  service.ctx.transparentForwardedResponse ??= Object.create(
    TransparentForwardedResponseService.prototype,
  );
  service.ctx.transparentForwardedResponse.ctx = service.ctx;
  service.ctx.transparentBackendOutbound ??= Object.create(
    TransparentBackendOutboundService.prototype,
  );
  service.ctx.transparentBackendOutbound.ctx = service.ctx;
  service.ctx.transparentBackendMessageCoordinator = Object.assign(
    Object.create(TransparentBackendMessageCoordinatorService.prototype),
    { ctx: service.ctx },
  );
  attachTransparentInternalResponseCoordinator(service);
  attachTransparentBackendSession(service);
  return service.ctx.transparentBackendMessageCoordinator;
}

export function attachTransparentBackendSession(service) {
  service.ctx.transparentBackendSession = Object.assign(
    Object.create(TransparentBackendSessionService.prototype),
    { ctx: service.ctx },
  );
  return service.ctx.transparentBackendSession;
}

export function attachTransparentInternalResponseCoordinator(service) {
  typedBinding(service);
  service.ctx.threadArtifactStore ??= {
    current: () => null,
    discard: () => {},
    commit: (artifact) => artifact,
  };
  service.ctx.transparentBackendProjection ??= {
    projectThread: (outerThreadId, thread, state) =>
      service.projectThread?.(outerThreadId, thread, state),
  };
  service.ctx.transparentProtocolMapper ??= {
    toVirtual: (path) => path,
  };
  service.ctx.transparentInternalResponseCoordinator = Object.assign(
    Object.create(TransparentInternalResponseCoordinatorService.prototype),
    { ctx: service.ctx },
  );
  return service.ctx.transparentInternalResponseCoordinator;
}

export function attachTransparentBackendProjection(service) {
  attachTransparentRuntimeAccess(service);
  service.ctx.appServerProjection ??= {
    projectThread: () => {},
    projectBackend: () => {},
  };
  service.ctx.transparentRuntimeRetirement ??= {
    retireThreadRuntimeIfIdle: () => false,
  };
  service.ctx.transparentBackendProjection = Object.assign(
    Object.create(TransparentBackendProjectionService.prototype),
    { ctx: service.ctx },
  );
  return service.ctx.transparentBackendProjection;
}

export function attachTransparentProtocolMapper(service) {
  typedBinding(service);
  service.ctx.transparentProtocolMapper = Object.assign(
    Object.create(TransparentProtocolMapperService.prototype),
    { ctx: service.ctx },
  );
  service.ctx.transparentBackendRegistry ??= {
    backends: service.backends ?? new Map(),
    connections: service.connections ?? new Map(),
  };
  service.ctx.transparentRuntimeLocator = Object.assign(
    Object.create(TransparentRuntimeLocatorService.prototype),
    { ctx: service.ctx },
  );
  service.ctx.transparentRuntimeAccess = null;
  attachTransparentRuntimeAccess(service);
  attachTransparentBackendChannel(service);
  attachTransparentBackendProjection(service);
  return service.ctx.transparentProtocolMapper;
}
