import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startPersonalAssistant } from "../src/runtime/personal-assistant.mjs";
import {
  platformAssistantPort,
  httpPlatformAssistantPort,
} from "../src/adapters/local/platform-assistant-port.mjs";
import { provisionBotProfile } from "../src/adapters/local/bot-profile.mjs";
import { ReceptionPlanner } from "../src/application/reception/planner.mjs";

const binding = {
  serverId: "installation",
  botId: "bot-one",
  assignmentId: "assignment",
  owner: { kind: "human", id: "human://authority/owner" },
};
test("shared Host activation validates a claimed binding, model can query groups and conversations without creating memories", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "personal-assistant-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const calls = [];
  const port = platformAssistantPort({
    async request(method, params) {
      calls.push({ method, params });
      if (method.endsWith("/authorize"))
        return { binding, epoch: "first", expiresAt: Date.now() + 15000 };
      if (method.endsWith("/groups/list"))
        return {
          groups: [{ id: "group:one", title: "项目群", kind: "group" }],
        };
      if (method.endsWith("/conversations/list"))
        return {
          conversations: [
            { ref: { serverId: "codex", threadId: "thread" }, title: "进展" },
          ],
          nextCursor: null,
        };
      throw Error("unexpected request");
    },
  });
  const runner = await startPersonalAssistant({
    serverDirectory: root,
    port,
    profileOptions: { telemetry: { enabled: false } },
  });
  t.after(() => runner.close());
  assert.ok(existsSync(join(root, "bots", "bot-one", "memory")));
  const receipt = runner.app.reception.accept("owner-query", {
    text: "有哪些群和会话？",
  });
  const turn = runner.app.reception.turn("owner-query");
  assert.ok(receipt);
  const seen = [];
  const model = {
    async decide(input) {
      seen.push(input);
      if (input.observations.length === 0)
        return { kind: "query", name: "platform.groups.list", params: {} };
      if (input.observations.length === 1)
        return {
          kind: "query",
          name: "platform.conversations.list",
          params: {},
        };
      return {
        kind: "reply",
        text: input.observations[0].response.data.groups[0].title,
      };
    },
  };
  const planner = new ReceptionPlanner(model, runner.app.receptionQueries);
  const result = await planner.plan(
    turn,
    runner.app.reception.context(turn),
    new AbortController().signal,
  );
  assert.equal(result.proposal.text, "项目群");
  assert.equal(result.queries.length, 2);
  assert.equal(seen.at(-1).observations[0].response.data.externalContext, true);
  assert.equal(result.queries[0].name, "platform.groups.list");
  assert.equal(
    runner.uow.db.prepare("SELECT COUNT(*) AS n FROM memory").get().n,
    0,
  );
  assert.throws(
    () => runner.platformChannels.send("group:one", { text: "no" }),
    /read-only/,
  );
  await assert.rejects(
    port.request(binding, "opencraft/channels/messages/send", {}),
    /Unsupported personal assistant operation/,
  );
  assert.throws(
    () =>
      provisionBotProfile(root, {
        ...binding,
        owner: { kind: "project", id: "project" },
      }),
    /Only personal/,
  );
});
test("HTTP Bot adapter is pinned to its origin, refuses redirects/write methods and does not send Human credentials", async () => {
  const calls = [];
  const syntheticBotToken = `oc_actor_v1.${randomUUID()}`;
  const port = httpPlatformAssistantPort({
    origin: "http://127.0.0.1:1234",
    token: syntheticBotToken,
    fetch: async (url, options) => {
      calls.push({ url: String(url), options });
      return new Response(
        JSON.stringify({
          binding,
          epoch: "first",
          expiresAt: Date.now() + 1000,
        }),
        { status: 200 },
      );
    },
  });
  await port.authorize(binding);
  assert.match(calls[0].url, /personal-assistant\/authorize$/);
  assert.equal(calls[0].options.redirect, "error");
  assert.equal(calls[0].options.credentials, "omit");
  assert.equal(calls[0].options.headers.authorization, `Bearer ${syntheticBotToken}`);
  assert.throws(
    () =>
      httpPlatformAssistantPort({
        origin: "http://remote.example",
        token: syntheticBotToken,
      }),
    /HTTPS/,
  );
  await assert.rejects(port.request(binding, "groups/list", {}), /Unsupported personal assistant operation/);
});
