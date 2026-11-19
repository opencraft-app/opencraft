import { openServerDatabase } from "@opencraft/storage-node/server";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import WebSocket from "ws";
import { AppHostServer } from "@opencraft/app-host-server";
import { JsonRpcAppServerClient } from "@opencraft/appserver-client";
import { CHANNELS_CHANGED, CHANNELS_EXTENSION, CHANNELS_HOST_ID } from "@opencraft/appserver-protocol";
import { ActorAccess } from "../../packages/access-control/src/actor-access";
import { ActorStore } from "../../packages/access-control/src/actors";
import {
  Collaboration,
  CollaborationHttpApi,
  type ConversationExecutionPort,
  type ExecutionReceipt,
} from "../../packages/access-control/src/collaboration";
import { parsePrincipal } from "../../packages/identity-core/src/index";
import { connectWebSocketAppHost } from "../../apps/workbench-web/src/runtime/websocket-app-host";
import { createWorkbenchWebServer } from "../../scripts/serve-workbench-web.mjs";

import { ImChannelsAppServer } from "../../scripts/im-channels-appserver.mjs";

test(
  "native channels share one AppServer timeline for people and bots, including restart and membership fencing",
  { timeout: 15000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "native-channels-"));
    const storage = await openServerDatabase(directory);
    const actors = new ActorStore(storage);
    const people = Object.fromEntries(
      ["Alice", "Bob", "Outsider"].map((name) => [
        name,
        parsePrincipal({ provider: "local", subject: name, displayName: name, expiresAt: Date.now() + 60000 })!,
      ]),
    );
    const alice = actors.resolveHuman(people.Alice!)!,
      bob = actors.resolveHuman(people.Bob!)!;
    const bots = ["Review Bot", "Build Bot"].map((name) => actors.createSession(name, alice.actorId));
    const credentials = bots.map((bot) => actors.issueCredential(bot.id, Date.now() + 60000, alice.actorId));
    for (const bot of bots) actors.setGrant(alice.actorId, bot.id, "execution.queue", true, alice.actorId);
    actors.setGrant(alice.actorId, bots[0]!.id, "message.send", true, alice.actorId);
    const access = new ActorAccess(actors, {
      authenticateHuman: (request) => people[request.headers.cookie ?? ""] ?? null,
      admitted: () => true,
      administrator: () => false,
    });
    const receipts = new Map<string, ExecutionReceipt>();
    const admissions: string[] = [];
    const execution: ConversationExecutionPort = {
      hostId: "fixture",
      async validate() {},
      async receipt(_binding, id) {
        return receipts.get(id) ?? null;
      },
      async add(binding, id, input, canAdmit) {
        assert.ok(canAdmit?.());
        assert.match(input, /check the build/u);
        admissions.push(binding.actorId);
        const receipt = { id, state: "queued", targetTurnId: null };
        receipts.set(id, receipt);
        return receipt;
      },
      async steer() {
        assert.fail("unexpected steer");
      },
      async cancel() {
        return true;
      },
    };
    const open = () => new Collaboration(storage, actors, execution);
    let collaboration = open();
    for (const bot of bots) await collaboration.bind(bot.id, bot.id, 0, () => {});
    const host = new AppHostServer({
      logicalClientRouting: true,
      physicalHostLifetime: "server",
      createTransport(id) {
        assert.equal(id, CHANNELS_HOST_ID);
        return new ImChannelsAppServer(() => collaboration);
      },
    });
    const http = new CollaborationHttpApi(collaboration, access);
    const gateway = await createWorkbenchWebServer({
      root: directory,
      appServerTarget: null,
      appHostServer: host,
      actorService: access,
      allowSessionChannels: true,
      actorCollaborationService: http,
      loopbackOnly: true,
      onAppHostDiagnostic() {},
    });
    const { port } = await gateway.listen({ host: "127.0.0.1", port: 0 });
    const origin = "http://127.0.0.1:" + port;
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    Object.defineProperty(globalThis, "window", { configurable: true, value: { location: new URL(origin) } });
    const connections: ReturnType<typeof connect>[] = [];
    function connect(headers: Record<string, string>) {
      let socket: WebSocket;
      const wire = connectWebSocketAppHost(
        (url) => {
          socket = new WebSocket(url, { origin, headers });
          return socket as unknown as globalThis.WebSocket;
        },
        { reportFailure() {} },
      );
      const client = new JsonRpcAppServerClient({
        hostId: CHANNELS_HOST_ID,
        transport: wire.createTransport(CHANNELS_HOST_ID),
        requestTimeoutMs: 3000,
      });
      return {
        wire,
        client,
        disconnect: async () => {
          const closed = once(socket, "close");
          socket.terminate();
          await closed;
        },
        initialize: () => client.connect({ clientInfo: { name: "test", version: "1" } }),
      };
    }
    function subscribe(client: JsonRpcAppServerClient, subscriptionId: string) {
      const hint = Promise.withResolvers<void>();
      const stop = client.subscribeNotification((event) => {
        if (
          event.method === CHANNELS_CHANGED &&
          (event.params as { subscriptionId: string }).subscriptionId === subscriptionId
        ) {
          stop();
          hint.resolve();
        }
      });
      return hint.promise;
    }
    const textParts = (text: string): [{ type: "text"; text: string }] => [{ type: "text", text }];
    try {
      const owner = connect({ cookie: "Alice" }),
        member = connect({ cookie: "Bob" }),
        outsider = connect({ cookie: "Outsider" });
      const [review, build] = credentials.map((credential) =>
        connect({ authorization: "Bearer " + credential.token }),
      ) as [ReturnType<typeof connect>, ReturnType<typeof connect>];
      connections.push(owner, member, outsider, review, build);
      const initialized = await Promise.all(connections.map((connection) => connection.initialize()));
      assert.deepEqual(initialized[3]?.capabilities?.extensions?.[CHANNELS_EXTENSION], {
        version: 1,
        native: true,
        inbox: 1,
        read: true,
        groupLifecycle: 1,
        attachments: 1,
        attachmentChunks: 1,
        authority: actors.authority,
        actorId: bots[0]!.id,
      });
      // An unauthorized Host attach deliberately retires its physical wire.
      // Probe on a separate connection so the channel reader remains usable.
      const denied = connect({ authorization: "Bearer " + credentials[0]!.token });
      try {
        await denied.initialize();
        await assert.rejects(denied.wire.createTransport("local-codex").connect());
      } finally {
        await denied.client.close();
        denied.wire.close();
      }

      const direct = await owner.client.request("opencraft/channels/direct/open", { actorId: bots[0]!.id });
      await review.client.request("opencraft/channels/subscribe", { channelId: direct.id, subscriptionId: "direct" });
      const directHint = subscribe(review.client, "direct");
      const dm = await fetch(origin + "/__opencraft_actors/collaboration/messages", {
        method: "POST",
        headers: { origin, cookie: "Alice", "content-type": "application/json" },
        body: JSON.stringify({ targetActorId: bots[0]!.id, content: "hello", idempotencyKey: "same-http-and-ws" }),
      });
      assert.equal(dm.status, 200);
      const dmBody = await dm.json();
      await directHint;
      const replay = await owner.client.request("opencraft/channels/messages/send", {
        channelId: direct.id,
        clientMessageId: "same-http-and-ws",
        parts: textParts("hello"),
      });
      assert.equal(replay.receipt.messageId, dmBody.messageId);
      assert.equal(
        (await review.client.request("opencraft/channels/messages/list", { channelId: direct.id })).messages.length,
        1,
      );

      const create = {
        title: "Launch",
        memberActorIds: [bob.actorId, ...bots.map((bot) => bot.id)],
        clientRequestId: "create-launch",
      };
      const group = await owner.client.request("opencraft/channels/group/create", create);
      const candidates = await owner.client.request("opencraft/channels/group/candidates/search", { query: "review" });
      assert.deepEqual(candidates.candidates, [
        { actorId: bots[0]!.id, displayName: "Review Bot", actorKind: "session" },
      ]);
      assert.deepEqual(
        await owner.client.request("opencraft/channels/group/candidates/search", {
          query: "review",
          channelId: group.id,
        }),
        { candidates: [] },
      );
      await assert.rejects(
        member.client.request("opencraft/channels/group/candidates/search", { query: "", channelId: group.id }),
        /channel_denied/,
      );
      await assert.rejects(
        review.client.request("opencraft/channels/group/candidates/search", { query: "" }),
        /channel_denied/,
      );
      assert.deepEqual(await owner.client.request("opencraft/channels/group/create", create), group);
      await assert.rejects(
        owner.client.request("opencraft/channels/group/create", { ...create, title: "Other" }),
        /idempotency_conflict/,
      );
      await assert.rejects(review.client.request("opencraft/channels/group/create", create), /channel_denied/);
      await assert.rejects(
        member.client.request("opencraft/channels/group/member/set", {
          channelId: group.id,
          actorId: bots[0]!.id,
          present: false,
          clientRequestId: "remove-unauthorized",
        }),
        /channel_denied/,
      );
      assert.deepEqual(await outsider.client.request("opencraft/channels/list", {}), { groups: [] });
      await assert.rejects(
        outsider.client.request("opencraft/channels/subscribe", { channelId: group.id, subscriptionId: "guess" }),
        /channel_denied/,
      );
      await assert.rejects(
        outsider.client.request("opencraft/channels/sync", { channelId: group.id }),
        /channel_denied/,
      );
      await assert.rejects(
        outsider.client.request("opencraft/channels/group/members/list", { channelId: group.id }),
        /channel_denied/,
      );
      const members = await member.client.request("opencraft/channels/group/members/list", { channelId: group.id });
      assert.deepEqual(
        members.members
          .filter((person) => person.actorKind === "session")
          .map((person) => person.actorId)
          .sort(),
        bots.map((bot) => bot.id).sort(),
      );

      const first = await review.client.request("opencraft/channels/sync", { channelId: group.id });
      await build.client.request("opencraft/channels/subscribe", { channelId: group.id, subscriptionId: "build-room" });
      const buildHint = subscribe(build.client, "build-room");
      const send = {
        channelId: group.id,
        clientMessageId: "please-review",
        parts: textParts("check the build"),
        wakeActorIds: bots.map((bot) => bot.id),
      };
      const { receipt } = await owner.client.request("opencraft/channels/messages/send", send);
      assert.equal(receipt.executionRequests?.length, 2);
      await buildHint;
      const buildBeforeRemoval = await build.client.request("opencraft/channels/sync", { channelId: group.id });
      assert.equal(buildBeforeRemoval.messages[0]?.executionRequests?.length, 1);
      assert.equal(
        (await member.client.request("opencraft/channels/messages/list", { channelId: group.id })).messages[0]
          ?.executionRequests,
        undefined,
      );
      const matches = await member.client.request("opencraft/channels/messages/search", {
        channelId: group.id,
        query: "build",
        limit: 1,
      });
      assert.equal(matches.messages[0]?.messageId, receipt.messageId);
      assert.equal(matches.messages[0]?.executionRequests, undefined);
      assert.equal(matches.hasEarlier, false);
      const globalMatches = await member.client.request("opencraft/channels/search", { query: "build" });
      assert.equal(globalMatches.matches[0]?.channel.id, group.id);
      assert.equal(globalMatches.matches[0]?.message.messageId, receipt.messageId);
      assert.deepEqual(await outsider.client.request("opencraft/channels/search", { query: "build" }), {
        matches: [],
        nextBefore: null,
      });
      await assert.rejects(
        outsider.client.request("opencraft/channels/messages/search", { channelId: group.id, query: "build" }),
        /channel_denied/,
      );
      await assert.rejects(
        member.client.request("opencraft/channels/messages/search", { channelId: group.id, query: "build", limit: 51 }),
      );
      await assert.rejects(
        review.client.request("opencraft/channels/messages/send", { ...send, clientMessageId: "loop" }),
        /channel_denied/,
      );
      await assert.rejects(
        review.client.request("opencraft/channels/messages/send", {
          channelId: group.id,
          clientMessageId: "cross-reply",
          parts: textParts("blocked"),
          replyToMessageId: replay.receipt.messageId,
        }),
        /channel_denied/,
      );

      const revokedHint = subscribe(build.client, "build-room");
      const remove = { channelId: group.id, actorId: bots[1]!.id, present: false, clientRequestId: "remove-build" };
      await owner.client.request("opencraft/channels/group/member/set", remove);
      await revokedHint;
      await assert.rejects(
        build.client.request("opencraft/channels/messages/list", { channelId: group.id }),
        /channel_denied/,
      );
      await assert.rejects(
        owner.client.request("opencraft/channels/messages/send", { ...send, clientMessageId: "stale-mention" }),
        /channel_wake_unavailable/,
      );
      assert.equal(
        (await owner.client.request("opencraft/channels/messages/list", { channelId: group.id })).messages.length,
        1,
      );
      await owner.client.request("opencraft/channels/group/member/set", {
        ...remove,
        present: true,
        clientRequestId: "readd-build",
      });
      await owner.client.request("opencraft/channels/group/member/set", remove);
      const rejoined = await build.client.request("opencraft/channels/sync", {
        channelId: group.id,
        cursor: buildBeforeRemoval.cursor,
      });
      assert.equal(rejoined.kind, "snapshot");
      assert.equal(rejoined.messages.length, 1);

      await Promise.all(connections.map((connection) => connection.disconnect()));
      await host.resetHost(CHANNELS_HOST_ID);
      await collaboration.close();
      collaboration = open();
      await collaboration.pump();
      await Promise.all(connections.map((connection) => connection.initialize()));
      const resumed = await review.client.request("opencraft/channels/sync", {
        channelId: group.id,
        cursor: first.cursor,
      });
      assert.equal(resumed.kind, "delta");
      assert.equal(resumed.messages[0]?.messageId, receipt.messageId);
      assert.deepEqual(await owner.client.request("opencraft/channels/messages/send", send), { receipt });
      await collaboration.pump();
      assert.deepEqual(admissions, [bots[0]!.id]);
      const reply = await review.client.request("opencraft/channels/messages/send", {
        channelId: group.id,
        clientMessageId: "bot-reply",
        parts: textParts("Looks good"),
        replyToMessageId: receipt.messageId,
      });
      assert.equal(reply.receipt.replyToMessageId, receipt.messageId);
      assert.deepEqual(reply.receipt.replyTo, { author: "Alice", text: "check the build" });
      const updated = await member.client.request("opencraft/channels/messages/list", { channelId: group.id });
      assert.equal(updated.messages[1]?.sender?.displayName, "Review Bot");
      assert.equal(updated.messages[1]?.sender?.actorKind, "session");
      assert.equal(updated.messages[1]?.sender?.isSelf, false);
      await owner.client.request("opencraft/channels/messages/send", {
        ...send,
        clientMessageId: "new-build-request",
        wakeActorIds: [bots[1]!.id],
      });
      await collaboration.pump();
      assert.deepEqual(
        admissions,
        bots.map((bot) => bot.id),
      );
      const buildReply = await build.client.request("opencraft/channels/messages/send", {
        channelId: group.id,
        clientMessageId: "bot-reply",
        parts: textParts("Build passed"),
      });
      assert.notEqual(buildReply.receipt.sender?.id, reply.receipt.sender?.id);
      assert.equal(
        (await member.client.request("opencraft/channels/messages/list", { channelId: group.id })).messages.length,
        4,
      );
      const directBeforeLink = await owner.client.request("opencraft/channels/sync", { channelId: direct.id });
      collaboration.request(alice, {
        targetActorId: bots[0]!.id,
        messageIds: [replay.receipt.messageId],
        execution: { mode: "queue" },
        idempotencyKey: "link-to-existing-direct-message",
      });
      const linked = await owner.client.request("opencraft/channels/sync", {
        channelId: direct.id,
        cursor: directBeforeLink.cursor,
      });
      assert.equal(linked.kind, "delta");
      assert.equal(linked.messages[0]?.sequence, replay.receipt.sequence);
      assert.ok(linked.messages[0]!.revision! > replay.receipt.revision!);
      assert.equal(linked.messages[0]?.executionRequests?.length, 1);
      await collaboration.synchronizeChannels({
        method: "configure",
        params: { incarnation: "test", bindings: [{ source: "wecom/fixture", channelId: group.id }], images: false },
      });
      const arrival = {
        source: "wecom/fixture",
        id: "external-msg",
        author: "Wei",
        sender: { id: "wei", displayName: "Wei" },
        text: "external via native channel",
        at: 1,
      };
      const externalHint = subscribe(member.client, "external");
      await member.client.request("opencraft/channels/subscribe", { channelId: group.id, subscriptionId: "external" });
      await collaboration.synchronizeChannels({
        method: "ingest",
        params: { incarnation: "test", source: arrival.source, arrival },
      });
      await externalHint;
      const externalHistory = await owner.client.request("opencraft/channels/messages/list", { channelId: group.id });
      assert.equal(externalHistory.messages.at(-1)?.sender?.kind, "external");
      assert.equal(
        (await owner.client.request("opencraft/channels/list", {})).groups.filter((g) => g.id === group.id).length,
        1,
      );
      await assert.rejects(owner.client.request("opencraft/channels/sync", { channelId: "old-shadow-id" }));
      await assert.rejects(owner.client.request("channelSync", { method: "configure", bindings: [] } as never));
    } finally {
      await Promise.allSettled(connections.map((connection) => connection.client.close()));
      for (const connection of connections) connection.wire.close();
      await gateway.close();
      await host.close();
      await collaboration.close();
      actors.close();
      await storage.close();
      if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
      else Reflect.deleteProperty(globalThis, "window");
      await rm(directory, { recursive: true, force: true });
    }
  },
);
