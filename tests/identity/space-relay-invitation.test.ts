import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSocketServer } from "ws";
import { ServerSpacesRuntime } from "../../packages/access-control/src/server-spaces-runtime.js";
import { createLocalIngress } from "../../packages/hub-network/src/local-ingress.js";
import { MACHINE_ENROLLMENT_PATHS } from "../../packages/relay-protocol/src/index.js";
import { connectRelay } from "../../plugins/relay-connect/src/server.js";
import { createRelayServer } from "../../apps/relay-server/src/server.js";
import {
  HostedSpaceRelay,
  JoinedSpaceRelay,
  encodeRelaySpaceInvite,
  type AttachedGuestSession,
} from "../../apps/local-agent-host/src/space-relay.js";

test("remote space invitation redeems over Relay, isolates myself, and revokes live sessions on member removal", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-space-relay-test-"));
  const inviterDir = join(root, "inviter");
  const inviteeDir = join(root, "invitee");
  const strangerDir = join(root, "stranger");
  const gatewayCredential = "A".repeat(43);

  let relayApp: ReturnType<typeof createRelayServer> | undefined;
  let inviterSpaces: ServerSpacesRuntime | undefined;
  let hostedRelay: HostedSpaceRelay | undefined;
  let joinedRelay: JoinedSpaceRelay | undefined;
  let strangerRelay: JoinedSpaceRelay | undefined;
  let machineRelay: ReturnType<typeof connectRelay> | undefined;
  let ingress: ReturnType<typeof createLocalIngress> | undefined;
  let hostHttp: ReturnType<typeof createServer> | undefined;
  const hostWs = new WebSocketServer({ noServer: true });

  try {
    // 1. Start standalone Relay Server with machineGateway enabled.
    let relayPort = 0;
    const tempProbe = createServer();
    await new Promise<void>(r => tempProbe.listen(0, "127.0.0.1", r));
    relayPort = (tempProbe.address() as { port: number }).port;
    await new Promise<void>(r => tempProbe.close(() => r()));
    const relayOrigin = `http://127.0.0.1:${relayPort}`;

    relayApp = createRelayServer([], {
      machineGateway: { origin: relayOrigin, credential: gatewayCredential },
    });
    await new Promise<void>(r => relayApp!.server.listen(relayPort, "127.0.0.1", r));

    // 2. Start Inviter's ServerSpacesRuntime + HostedSpaceRelay + minimal Space-scoped RPC host.
    inviterSpaces = new ServerSpacesRuntime({ directory: inviterDir });
    await inviterSpaces.ready;
    await inviterSpaces.assign(undefined, "local", "private-myself-thread", "myself");
    const created = await inviterSpaces.command(undefined, { action: "create", name: "yuehuali的上下文" }) as { spaceId: string };
    await inviterSpaces.assign(undefined, "local", "shared-team-thread", created.spaceId);

    hostedRelay = new HostedSpaceRelay(inviterDir, inviterSpaces);
    await hostedRelay.ready();

    const guestScopes = new WeakMap<any, AttachedGuestSession>();
    const allThreads = [
      { id: "private-myself-thread", preview: "Secret local note", createdAt: 1700000000 },
      { id: "shared-team-thread", preview: "Shared team discussion", createdAt: 1700000100 },
    ];

    hostWs.on("connection", ws => {
      const guest = guestScopes.get(ws)!;
      const unsub = inviterSpaces!.subscribe(() => {
        if (!inviterSpaces!.hasMember(guest.actorContext.actorId, guest.spaceId)) {
          ws.close(1008, "Space membership revoked");
        } else {
          ws.send(JSON.stringify({ jsonrpc: "2.0", method: "opencraft/server-spaces/changed", params: {} }));
        }
      });
      ws.once("close", unsub);
      ws.on("message", async raw => {
        const msg = JSON.parse(raw.toString("utf8"));
        if (!("id" in msg)) return;
        if (msg.method === "initialize") {
          ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { capabilities: { extensions: { "opencraft/server-spaces": { version: 1 } } } } }));
          return;
        }
        if (msg.method === "opencraft/server-spaces") {
          try {
            const res = await inviterSpaces!.command(guest.actorContext, msg.params);
            ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: res }));
          } catch {
            ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32004, message: "Unavailable" } }));
          }
          return;
        }
        if (msg.method === "thread/list") {
          const visible = allThreads.filter(t => inviterSpaces!.spaceFor("local", t.id) === guest.spaceId);
          ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { data: visible, nextCursor: null } }));
          return;
        }
        if (msg.method === "thread/read") {
          const tid = msg.params?.threadId;
          if (inviterSpaces!.spaceFor("local", tid) !== guest.spaceId) {
            ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32004, message: "Conversation unavailable" } }));
            return;
          }
          ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { thread: allThreads.find(t => t.id === tid) } }));
          return;
        }
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32004, message: "Forbidden method" } }));
      });
    });

    hostHttp = createServer((req, res) => {
      if ((req.url ?? "").startsWith("/__opencraft_machines/enroll")) {
        void hostedRelay!.tryHandleHttp(req, res);
        return;
      }
      res.writeHead(404).end();
    });
    hostHttp.on("upgrade", (req, socket, head) => {
      if (hostedRelay!.tryHandleUpgrade(req, socket, head, (ws, session) => {
        guestScopes.set(ws, session);
        hostWs.emit("connection", ws, req);
      })) return;
      socket.destroy();
    });
    await new Promise<void>(r => hostHttp!.listen(0, "127.0.0.1", r));
    const hostPort = (hostHttp.address() as { port: number }).port;

    ingress = createLocalIngress(() => ({ port: hostPort, origin: relayOrigin }), MACHINE_ENROLLMENT_PATHS);
    machineRelay = connectRelay({
      relay: relayOrigin,
      credential: gatewayCredential,
      allowLoopbackInsecure: true,
      machineGateway: true,
      acceptStream: stream => ingress!.accept(stream),
    });

    // Wait for Inviter's Relay control socket to connect.
    for (let i = 0; i < 40 && !machineRelay.connected(); i++) {
      await new Promise(r => setTimeout(r, 50));
    }
    assert.equal(machineRelay.connected(), true, "Inviter connected to Relay gateway");

    // 3. Inviter generates a Relay invitation token for "yuehuali的上下文".
    const rawInvite = await inviterSpaces.command(undefined, { action: "invite", spaceId: created.spaceId }) as { code: string };
    const relayToken = encodeRelaySpaceInvite({ origin: relayOrigin, code: rawInvite.code });
    assert.match(relayToken, /^ocinv1_/u);

    // 4. Invitee redeems the invitation over the Relay!
    joinedRelay = new JoinedSpaceRelay(inviteeDir, () => {}, () => {}, {
      allowLoopbackInsecure: true,
      localDisplayName: "Bob's MacBook",
    });
    await joinedRelay.ready();
    const joined = await joinedRelay.join(relayToken);
    assert.match(joined.spaceId, /^rspace:[a-f0-9]{12}$/u);

    // 5. Invitee sees ONLY the shared space & shared thread (NEVER Inviter's myself)!
    const merged = joinedRelay.mergeDirectory({ actorId: "local-bob", spaces: [{ id: "myself", name: "myself", role: "owner", memberCount: 1 }], assignments: [] });
    const remoteSpace = merged.spaces.find(s => s.id === joined.spaceId);
    assert.ok(remoteSpace);
    assert.equal(remoteSpace.name, "yuehuali的上下文");
    assert.equal(remoteSpace.role, "member");
    assert.equal(remoteSpace.memberCount, 2);

    const remoteThreads = await joinedRelay.listAllRemoteThreads() as Array<{ id: string }>;
    assert.equal(remoteThreads.length, 1);
    assert.match(remoteThreads[0]!.id, /^rspace_[a-f0-9]{12}_shared-team-thread$/u);

    // Reading Inviter's private myself thread fails!
    const prefix = joined.spaceId.slice("rspace:".length);
    await assert.rejects(
      () => joinedRelay!.forwardThreadRequest(`rspace_${prefix}_private-myself-thread`, "thread/read", { threadId: `rspace_${prefix}_private-myself-thread` }),
      /Conversation unavailable/u,
    );

    // 6. One-time code cannot be reused by a third party!
    strangerRelay = new JoinedSpaceRelay(strangerDir, () => {}, () => {}, { allowLoopbackInsecure: true, localDisplayName: "Eve" });
    await strangerRelay.ready();
    await assert.rejects(() => strangerRelay!.join(relayToken));

    // 7. Inviter sees Bob in members list, then removes Bob -> live Relay session is immediately revoked!
    const membersRes = await inviterSpaces.command(undefined, { action: "members", spaceId: created.spaceId }) as { members: Array<{ actorId: string; displayName: string; role: string }> };
    const bobMember = membersRes.members.find(m => m.displayName === "Bob's MacBook");
    assert.ok(bobMember);
    assert.equal(bobMember.role, "member");

    await inviterSpaces.command(undefined, { action: "remove", spaceId: created.spaceId, actorId: bobMember.actorId });
    await new Promise(r => setTimeout(r, 150));
    await assert.rejects(
      () => joinedRelay!.members(joined.spaceId),
      /closed|offline|unavailable/iu,
    );
  } finally {
    await strangerRelay?.close();
    await joinedRelay?.close();
    machineRelay?.close();
    ingress?.close();
    await hostedRelay?.close();
    await inviterSpaces?.close();
    hostWs.close();
    if (hostHttp?.listening) await new Promise<void>(r => hostHttp!.close(() => r()));
    await relayApp?.close();
    await rm(root, { recursive: true, force: true });
  }
});
