import assert from "node:assert/strict";
import test from "node:test";

import {
  InMemoryMockStore,
  createMockControlServer,
  identityAliasHash,
} from "./server.mjs";

const catalog = {
  capabilities: new Map([
    [
      "tencentcloud.faceid.id-card-verification",
      {
        id: "tencentcloud.faceid.id-card-verification",
        defaultPreset: "success",
        presets: new Set(["success", "identity-mismatch"]),
      },
    ],
  ]),
  scenarios: new Map([
    ["full", { id: "full", name: "完整成功链路", tags: ["default"], overrides: {} }],
    [
      "realname-failed",
      {
        id: "realname-failed",
        name: "实名不通过",
        tags: ["auth", "realname"],
        overrides: {
          "tencentcloud.faceid.id-card-verification": {
            preset: "identity-mismatch",
          },
        },
      },
    ],
  ]),
};

async function startControl(t) {
  const store = new InMemoryMockStore();
  const server = createMockControlServer({
    catalog,
    store,
    developmentSMSCode: "123456",
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  return {
    baseURL: `http://127.0.0.1:${address.port}`,
    store,
  };
}

async function createUser(baseURL, scenarioId = "full") {
  const response = await fetch(`${baseURL}/v1/users`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scenarioId }),
  });
  assert.equal(response.status, 201);
  return response.json();
}

test("blank-user creation generates durable unique protocol identities", async (t) => {
  const { baseURL } = await startControl(t);

  const first = await createUser(baseURL);
  const second = await createUser(baseURL);

  assert.notEqual(first.mockUserId, second.mockUserId);
  assert.notEqual(first.qqOpenId, second.qqOpenId);
  assert.notEqual(first.phone, second.phone);
  assert.notEqual(first.realname.idCard, second.realname.idCard);
  assert.match(first.phone, /^1\d{10}$/);
  assert.match(first.realname.idCard, /^\d{17}[\dX]$/);
  assert.equal(first.scenarioId, "full");
  assert.equal(first.developmentSMSCode, "123456");
});

test("existing-user list is paginated and excludes identity fixtures", async (t) => {
  const { baseURL } = await startControl(t);
  await createUser(baseURL);
  await createUser(baseURL, "realname-failed");

  const response = await fetch(`${baseURL}/v1/users?page=1&page_size=1`);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.total, 2);
  assert.equal(payload.items.length, 1);
  assert.equal(payload.items[0].scenarioId, "realname-failed");
  assert.equal("phone" in payload.items[0], false);
  assert.equal("realname" in payload.items[0], false);
});

test("resolve uses the selected user's scenario and defaults unspecified capabilities", async (t) => {
  const { baseURL } = await startControl(t);
  const failedUser = await createUser(baseURL, "realname-failed");
  const fullUser = await createUser(baseURL);

  const failedResponse = await fetch(`${baseURL}/v1/resolve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      capabilityId: "tencentcloud.faceid.id-card-verification",
      identityAliasHash: identityAliasHash(
        failedUser.realname.name,
        failedUser.realname.idCard,
      ),
    }),
  });
  const failed = await failedResponse.json();

  const fullResponse = await fetch(`${baseURL}/v1/resolve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      capabilityId: "tencentcloud.faceid.id-card-verification",
      identityAliasHash: identityAliasHash(
        fullUser.realname.name,
        fullUser.realname.idCard,
      ),
    }),
  });
  const full = await fullResponse.json();

  assert.equal(failed.preset, "identity-mismatch");
  assert.equal(full.preset, "success");
});

test("scenario switch affects resolves started after the committed update", async (t) => {
  const { baseURL } = await startControl(t);
  const user = await createUser(baseURL);

  const update = await fetch(
    `${baseURL}/v1/users/${encodeURIComponent(user.mockUserId)}/scenario`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scenarioId: "realname-failed" }),
    },
  );
  assert.equal(update.status, 200);

  const response = await fetch(`${baseURL}/v1/resolve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      capabilityId: "tencentcloud.faceid.id-card-verification",
      identityAliasHash: identityAliasHash(
        user.realname.name,
        user.realname.idCard,
      ),
    }),
  });
  const payload = await response.json();

  assert.equal(payload.scenarioId, "realname-failed");
  assert.equal(payload.preset, "identity-mismatch");
});
