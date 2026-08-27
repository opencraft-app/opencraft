import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import test from "node:test";
import { fileURLToPath } from "node:url";

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

async function waitForHealth(port) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.ok) return;
    } catch {
      // The child process may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("fake QQ server did not become healthy");
}

async function startControlStub(t) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://mock-control");
    requests.push({ method: req.method, pathname: url.pathname });
    res.setHeader("content-type", "application/json");

    if (req.method === "GET" && url.pathname === "/v1/users") {
      res.end(JSON.stringify({
        items: [
          {
            mockUserId: "local-user-000001",
            displayName: "已有测试用户",
            scenarioId: "full",
          },
        ],
        total: 1,
      }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/v1/scenarios") {
      res.end(JSON.stringify({
        items: [
          { id: "full", name: "完整成功链路", tags: ["default"] },
          { id: "realname-failed", name: "实名不通过", tags: ["realname"] },
        ],
        total: 2,
      }));
      return;
    }
    if (
      req.method === "GET" &&
      url.pathname === "/v1/users/local-user-000002"
    ) {
      res.end(JSON.stringify({
        mockUserId: "local-user-000002",
        qqOpenId: "fake-qq-openid-local-user-000002",
        displayName: "空白用户 000002",
        phone: "13900000002",
        realname: {
          name: "本地用户二",
          idCard: "110105199001010021",
        },
        scenarioId: "realname-failed",
        developmentSMSCode: "123456",
      }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/v1/users") {
      res.statusCode = 201;
      res.end(JSON.stringify({
        mockUserId: "local-user-000002",
        qqOpenId: "fake-qq-openid-local-user-000002",
        displayName: "空白用户 000002",
        phone: "13900000002",
        realname: {
          name: "本地用户二",
          idCard: "110105199001010021",
        },
        scenarioId: "realname-failed",
        developmentSMSCode: "123456",
      }));
      return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not_found" }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return {
    baseURL: `http://127.0.0.1:${server.address().port}`,
    requests,
  };
}

async function startQQ(t, env = {}) {
  const port = await reservePort();
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("./server.mjs", import.meta.url))],
    {
      env: { ...process.env, FAKE_QQ_PORT: String(port), ...env },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  t.after(() => child.kill("SIGTERM"));
  await waitForHealth(port);
  return `http://127.0.0.1:${port}`;
}

test("scenario mode renders blank and existing user choices", async (t) => {
  const control = await startControlStub(t);
  const baseURL = await startQQ(t, {
    MOCK_CONTROL_BASE_URL: control.baseURL,
  });

  const response = await fetch(
    `${baseURL}/oauth2.0/authorize?redirect_uri=${encodeURIComponent("http://client.example/callback")}&state=state-1`,
    { redirect: "manual" },
  );
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.match(body, /创建空白用户/);
  assert.match(body, /已有测试用户/);
  assert.match(body, /实名不通过/);
});

test("blank selection shows its fixture before continuing the OAuth redirect", async (t) => {
  const control = await startControlStub(t);
  const baseURL = await startQQ(t, {
    MOCK_CONTROL_BASE_URL: control.baseURL,
  });
  const authorizeURL =
    `${baseURL}/oauth2.0/authorize?redirect_uri=${encodeURIComponent("http://client.example/callback")}&state=state-2`;

  const confirmation = await fetch(authorizeURL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      user_action: "create",
      scenario_id: "realname-failed",
    }),
    redirect: "manual",
  });

  assert.equal(confirmation.status, 200);
  const confirmationBody = await confirmation.text();
  assert.match(confirmationBody, /13900000002/);
  assert.match(confirmationBody, /110105199001010021/);
  assert.match(confirmationBody, /123456/);
  assert.match(confirmationBody, /继续登录/);

  const response = await fetch(authorizeURL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      user_action: "continue",
      mock_user_id: "local-user-000002",
    }),
    redirect: "manual",
  });

  assert.equal(response.status, 302);
  const location = new URL(response.headers.get("location"));
  assert.equal(location.origin, "http://client.example");
  assert.equal(location.searchParams.get("state"), "state-2");
  assert.match(location.searchParams.get("code"), /^fake-qq-code-/);
  assert.equal(
    control.requests.some(
      (request) =>
        request.method === "POST" && request.pathname === "/v1/users",
    ),
    true,
  );
});

test("legacy mode preserves the immediate redirect", async (t) => {
  const baseURL = await startQQ(t);

  const response = await fetch(
    `${baseURL}/oauth2.0/authorize?redirect_uri=${encodeURIComponent("http://client.example/callback")}`,
    { redirect: "manual" },
  );

  assert.equal(response.status, 302);
  assert.match(
    new URL(response.headers.get("location")).searchParams.get("code"),
    /^fake-qq-code-/,
  );
});
