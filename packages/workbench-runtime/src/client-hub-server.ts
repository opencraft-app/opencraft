import type { AppServerHostKind } from "@opencraft/appserver-session";

export interface ClientHubAttachment {
  readonly clientId: string;
  readonly incarnation: string;
  readonly hubId: string;
  readonly tenantId: string;
  readonly leaseId: string;
}

export interface HubServerRoute {
  readonly hubId: string;
  readonly tenantId: string;
  readonly serverId: string;
  readonly routeId: string;
  readonly epoch: number;
}

export interface ServerHubAttachment {
  readonly serverId: string;
  readonly serverIncarnation: string;
  readonly hubId: string;
  readonly tenantId: string;
  readonly leaseId: string;
}

export interface HubLink {
  readonly linkId: string;
  readonly upstreamHubId: string;
  readonly upstreamTenantId: string;
  readonly downstreamHubId: string;
  readonly downstreamTenantId: string;
  readonly epoch: number;
  readonly leaseId: string;
}

export interface HubRouteEnvelope {
  readonly routeId: string;
  readonly serverId: string;
  readonly tenantId: string;
  readonly epoch: number;
  readonly executionKey: string;
  readonly visitedHubIds: readonly string[];
}

/** Stable Server provenance. Hub route, Host placement and activity state are separate facts. */
export interface ThreadServerOrigin {
  readonly serverId: string;
  readonly label: string;
}

export type ServerRouteLocality = "local" | "remote";

function required(value: string, name: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new RangeError(`${name} must not be empty`);
  return normalized;
}

export function clientHubAttachment(input: ClientHubAttachment): ClientHubAttachment {
  return Object.freeze({
    clientId: required(input.clientId, "Client ID"),
    incarnation: required(input.incarnation, "Client incarnation"),
    hubId: required(input.hubId, "Hub ID"),
    tenantId: required(input.tenantId, "Tenant ID"),
    leaseId: required(input.leaseId, "Client attachment lease ID"),
  });
}

export function hubServerRoute(input: HubServerRoute): HubServerRoute {
  if (!Number.isSafeInteger(input.epoch) || input.epoch < 0) {
    throw new RangeError("Hub route epoch must be a non-negative safe integer");
  }
  return Object.freeze({
    hubId: required(input.hubId, "Hub ID"),
    tenantId: required(input.tenantId, "Tenant ID"),
    serverId: required(input.serverId, "Server ID"),
    routeId: required(input.routeId, "Route ID"),
    epoch: input.epoch,
  });
}

export function serverHubAttachment(input: ServerHubAttachment): ServerHubAttachment {
  return Object.freeze({
    serverId: required(input.serverId, "Server ID"),
    serverIncarnation: required(input.serverIncarnation, "Server incarnation"),
    hubId: required(input.hubId, "Hub ID"),
    tenantId: required(input.tenantId, "Tenant ID"),
    leaseId: required(input.leaseId, "Server attachment lease ID"),
  });
}

export function hubLink(input: HubLink): HubLink {
  if (!Number.isSafeInteger(input.epoch) || input.epoch < 0) {
    throw new RangeError("Hub link epoch must be a non-negative safe integer");
  }
  const upstreamHubId = required(input.upstreamHubId, "Upstream Hub ID");
  const downstreamHubId = required(input.downstreamHubId, "Downstream Hub ID");
  if (upstreamHubId === downstreamHubId) throw new RangeError("Hub link must connect distinct Hubs");
  return Object.freeze({
    linkId: required(input.linkId, "Hub link ID"),
    upstreamHubId,
    upstreamTenantId: required(input.upstreamTenantId, "Upstream tenant ID"),
    downstreamHubId,
    downstreamTenantId: required(input.downstreamTenantId, "Downstream tenant ID"),
    epoch: input.epoch,
    leaseId: required(input.leaseId, "Hub link lease ID"),
  });
}

export function hubRouteEnvelope(input: HubRouteEnvelope): HubRouteEnvelope {
  if (!Number.isSafeInteger(input.epoch) || input.epoch < 0) {
    throw new RangeError("Hub route epoch must be a non-negative safe integer");
  }
  const visitedHubIds = input.visitedHubIds.map((hubId) => required(hubId, "Visited Hub ID"));
  if (new Set(visitedHubIds).size !== visitedHubIds.length) throw new RangeError("Hub route contains a loop");
  return Object.freeze({
    routeId: required(input.routeId, "Route ID"),
    serverId: required(input.serverId, "Server ID"),
    tenantId: required(input.tenantId, "Tenant ID"),
    epoch: input.epoch,
    executionKey: required(input.executionKey, "Execution key"),
    visitedHubIds: Object.freeze(visitedHubIds),
  });
}

export function advanceHubRoute(
  route: HubRouteEnvelope,
  nextHubId: string,
  maximumHops = 8,
): HubRouteEnvelope {
  if (!Number.isSafeInteger(maximumHops) || maximumHops < 1) {
    throw new RangeError("Maximum Hub hops must be a positive safe integer");
  }
  const hubId = required(nextHubId, "Next Hub ID");
  if (route.visitedHubIds.includes(hubId)) throw new RangeError(`Hub route loop at ${hubId}`);
  if (route.visitedHubIds.length >= maximumHops) throw new RangeError("Hub route exceeded maximum hops");
  return hubRouteEnvelope({ ...route, visitedHubIds: [...route.visitedHubIds, hubId] });
}

export function threadServerOrigin(input: ThreadServerOrigin): ThreadServerOrigin {
  return Object.freeze({
    serverId: required(input.serverId, "Server ID"),
    label: required(input.label, "Server label"),
  });
}

/**
 * Compatibility boundary for today's one Host profile -> one AppServer route.
 * New consumers must not infer Server identity from Host placement themselves.
 */
export function legacyDirectServerProjectionFromHost(input: {
  readonly hostId: string;
  readonly hostKind: AppServerHostKind;
  readonly label: string;
}): {
  readonly serverOrigin: ThreadServerOrigin;
  readonly serverRouteLocality: ServerRouteLocality;
} {
  return Object.freeze({
    serverOrigin: threadServerOrigin({ serverId: input.hostId, label: input.label }),
    serverRouteLocality: input.hostKind === "local" ? "local" : "remote",
  });
}
