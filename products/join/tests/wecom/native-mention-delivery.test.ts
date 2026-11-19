import "../../plugins/wecom/assistant-install.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openServerDatabase } from "@opencraft/storage-node/server";
import { ActorStore } from "../../../../packages/access-control/src/actors";
import { Collaboration } from "../../../../packages/access-control/src/collaboration";

test("real storage Worker claims durable native mentions only through current verified corporation bindings", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "native-mention-outbound-")),
    storage = await openServerDatabase(dir),
    actors = new ActorStore(storage),
    service = new Collaboration(storage, actors);
  t.after(async () => {
    await service.close();
    actors.close();
    await storage.close();
    await rm(dir, { recursive: true, force: true });
  });
  const human = (subject: string) =>
    actors.resolveHuman({
      provider: "local",
      subject,
      displayName: subject,
      expiresAt: Date.now() + 60000,
    })!;
  const alice = human("Alice"),
    bob = human("Bob"),
    call = (method: string, params = {}) =>
      service.communicate(alice, "opencraft/channels/" + method, params);
  const group = await call("group/create", {
    title: "Native",
    memberActorIds: [bob.actorId],
    clientRequestId: "group",
  });
  const before=await call('group/members/list',{channelId:group.id});
  assert.equal(before.members.find((m:any)=>m.actorId===bob.actorId).mentionDelivery,undefined);
  const source = JSON.stringify([
      "wecom-customer-service",
      "wxfixture",
      "fwfixture",
      "room",
    ]),
    sync = (method: string, params = {}) =>
      service.synchronizeChannels({
        method,
        params: { incarnation: "test", ...params },
      });
  await sync("configure", {
    bindings: [{ source, channelId: group.id }],
    images: false,
  });
  const unlinked=await call('group/members/list',{channelId:group.id});
  assert.equal(unlinked.members.find((m:any)=>m.actorId===bob.actorId).mentionDelivery,'native-only');
  await assert.rejects(sync('mirrorLink',{actorId:bob.actorId,generation:bob.generation,corpId:'other-corp',userId:'T999B'}),/channel_denied/);
  const foreign=await call('group/members/list',{channelId:group.id});
  assert.equal(foreign.members.find((m:any)=>m.actorId===bob.actorId).mentionDelivery,'native-only');
  await sync("mirrorLink", {
    actorId: bob.actorId,
    generation: bob.generation,
    corpId: "wxfixture",
    userId: "T123A",
  });
  const linked=await call('group/members/list',{channelId:group.id});
  assert.equal(linked.members.find((m:any)=>m.actorId===bob.actorId).mentionDelivery,'linked');
  const mentions = [{ actorId: bob.actorId, start: 3, end: 7 }],
    send = (key: string) =>
      call("messages/send", {
        channelId: group.id,
        clientMessageId: key,
        parts: [{ type: "text", text: "Hi @Bob" }],
        mentions,
      });
  const first = await send("once"),
    claim = await sync("claim");
  assert.equal(claim.messageId, first.receipt.messageId);
  assert.deepEqual(claim.mentions, [{ start: 3, end: 7, recipient: "T123A" }]);
  await sync("settle", { ...claim, status: "delivered" });
  assert.equal((await send("once")).receipt.messageId, claim.messageId);
  assert.equal(await sync("claim"), null);
  // A queued message never notifies a former native member, even if the provider still has that person.
  await send("left");
  await call("group/member/set", {
    channelId: group.id,
    actorId: bob.actorId,
    present: false,
    clientRequestId: "remove",
  });
  const left = await sync("claim");
  assert.equal(left.mentions, undefined);
  assert.equal(left.text, "Hi @Bob");
  await sync("settle", { ...left, status: "delivered" });
});
