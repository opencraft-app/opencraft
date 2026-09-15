import assert from "node:assert/strict";
import test from "node:test";

import { AdministratorService } from "../src/services/administrator.ts";

function serviceFor(user, { models = [], codex = null, render = () => "search result" } = {}) {
  const service = Object.create(AdministratorService.prototype);
  service.ctx = {
    userDirectory: { find: () => user },
    modelGateway: { visibleRecordsForUser: () => models },
    credential: { resolveCodexUser: () => codex },
    threadSearch: { render },
  };
  return service;
}

test("administrator defaults to an Agent whenever a visible model is configured", () => {
  const service = serviceFor({ role: "administrator" }, { models: [{ id: "public-model" }] });
  assert.equal(service.hasAgent({ identity: { id: "node:root" } }), true);
});

test("global conversation search is available to every registered user", () => {
  const connection = { identity: { id: "user:alice" } };
  assert.equal(
    serviceFor({ role: "member" }).search([], { connection }),
    "search result",
  );
  assert.equal(
    serviceFor({ role: "administrator" }).search([], { connection }),
    "search result",
  );
  assert.equal(
    serviceFor(null).search([], { connection }),
    "只有已登录的 HyperNode 用户可以搜索全局会话。",
  );
});

test("administrator search always excludes its current management thread", () => {
  let options = null;
  const connection = { identity: { id: "user:alice" } };
  const service = serviceFor({ role: "administrator" }, {
    render: (_input, received) => {
      options = received;
      return "search result";
    },
  });
  assert.equal(service.search([], { connection, threadId: "thread-admin" }), "search result");
  assert.deepEqual(options, {
    excludeThreadId: "thread-admin",
    actorPrincipalId: "user:alice",
  });
});
