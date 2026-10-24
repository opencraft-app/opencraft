import assert from "node:assert/strict";
import test from "node:test";

import {
  advanceHubRoute,
  clientHubAttachment,
  hubLink,
  hubRouteEnvelope,
  hubServerRoute,
  legacyDirectServerProjectionFromHost,
  serverHubAttachment,
} from "@opencraft/workbench-runtime";

test("Client and Server attachments are independent many-to-many relations", () => {
  const client = clientHubAttachment({
    clientId: "client-a",
    incarnation: "window-2",
    hubId: "hub-east",
    tenantId: "tenant-a",
    leaseId: "client-lease",
  });
  const server = serverHubAttachment({
    serverId: "server-a",
    serverIncarnation: "boot-7",
    hubId: "hub-east",
    tenantId: "tenant-a",
    leaseId: "server-lease",
  });
  assert.equal(client.hubId, server.hubId);
  assert.notEqual(client.leaseId, server.leaseId);
  assert.equal("serverId" in client, false);
  assert.equal("clientId" in server, false);
});

test("Hub cascade carries explicit tenant mapping and rejects loops", () => {
  const link = hubLink({
    linkId: "east-to-edge",
    upstreamHubId: "hub-east",
    upstreamTenantId: "tenant-a",
    downstreamHubId: "hub-edge",
    downstreamTenantId: "tenant-edge-a",
    epoch: 2,
    leaseId: "link-lease",
  });
  assert.notEqual(link.upstreamTenantId, link.downstreamTenantId);
  const route = hubRouteEnvelope({
    routeId: "route-a",
    serverId: "server-a",
    tenantId: "tenant-a",
    epoch: 4,
    executionKey: "turn-a:attempt-1",
    visitedHubIds: ["hub-client"],
  });
  const cascaded = advanceHubRoute(advanceHubRoute(route, "hub-east"), "hub-edge");
  assert.deepEqual(cascaded.visitedHubIds, ["hub-client", "hub-east", "hub-edge"]);
  assert.equal(cascaded.executionKey, route.executionKey);
  assert.throws(() => advanceHubRoute(cascaded, "hub-east"), /loop/u);
  assert.throws(() => hubRouteEnvelope({ ...route, visitedHubIds: ["hub-east", "hub-east"] }), /loop/u);
});

test("Server identity is stable when its Hub route changes", () => {
  const east = hubServerRoute({
    hubId: "hub-east",
    tenantId: "tenant-a",
    serverId: "server-a",
    routeId: "route-east",
    epoch: 3,
  });
  const west = hubServerRoute({
    hubId: "hub-west",
    tenantId: "tenant-a",
    serverId: "server-a",
    routeId: "route-west",
    epoch: 8,
  });
  assert.equal(east.serverId, west.serverId);
  assert.notEqual(east.hubId, west.hubId);
  assert.notEqual(east.routeId, west.routeId);
});

test("legacy direct topology is isolated behind one explicit projection", () => {
  assert.deepEqual(legacyDirectServerProjectionFromHost({
    hostId: "legacy-hermes-host",
    hostKind: "durable",
    label: "Hermes",
  }), {
    serverOrigin: { serverId: "legacy-hermes-host", label: "Hermes" },
    serverRouteLocality: "remote",
  });
});
