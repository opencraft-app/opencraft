import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
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
  throw new Error("fake Tencent Cloud server did not become healthy");
}

test("IdCardVerification returns a successful Tencent FaceID response", async (t) => {
  const port = await reservePort();
  const child = spawn(process.execPath, [fileURLToPath(new URL("./server.mjs", import.meta.url))], {
    env: { ...process.env, FAKE_TENCENTCLOUD_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => child.kill("SIGTERM"));

  await waitForHealth(port);
  const response = await fetch(`http://127.0.0.1:${port}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-tc-action": "IdCardVerification",
    },
    body: JSON.stringify({ Name: "Local Developer", IdCard: "11010519491231002X" }),
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.Response.Result, "0");
  assert.equal(payload.Response.Description, "local fake verification passed");
  assert.match(payload.Response.RequestId, /^local-/);
});

test("IdCardVerification uses the selected user's mismatch preset", async (t) => {
  let resolvedRequest;
  const control = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    resolvedRequest = JSON.parse(body);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      mockUserId: "local-user-000002",
      scenarioId: "realname-failed",
      preset: "identity-mismatch",
    }));
  });
  await new Promise((resolve, reject) => {
    control.once("error", reject);
    control.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => control.close(resolve)));

  const port = await reservePort();
  const child = spawn(process.execPath, [fileURLToPath(new URL("./server.mjs", import.meta.url))], {
    env: {
      ...process.env,
      FAKE_TENCENTCLOUD_PORT: String(port),
      MOCK_CONTROL_BASE_URL: `http://127.0.0.1:${control.address().port}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => child.kill("SIGTERM"));

  await waitForHealth(port);
  const response = await fetch(`http://127.0.0.1:${port}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-tc-action": "IdCardVerification",
    },
    body: JSON.stringify({
      Name: " 本地用户二 ",
      IdCard: "11010519900101002x",
    }),
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.notEqual(payload.Response.Result, "0");
  assert.equal(payload.Response.Description, "local fake identity mismatch");
  assert.equal(
    resolvedRequest.capabilityId,
    "tencentcloud.faceid.id-card-verification",
  );
  assert.match(resolvedRequest.identityAliasHash, /^[a-f0-9]{64}$/);
});

test("TLS endpoint serves FaceID with the checked-in local CA", async (t) => {
  const port = await reservePort();
  const tlsPort = await reservePort();
  const tlsDir = fileURLToPath(new URL("./tls/", import.meta.url));
  const child = spawn(process.execPath, [fileURLToPath(new URL("./server.mjs", import.meta.url))], {
    env: {
      ...process.env,
      FAKE_TENCENTCLOUD_PORT: String(port),
      FAKE_TENCENTCLOUD_TLS_PORT: String(tlsPort),
      FAKE_TENCENTCLOUD_TLS_CERT: `${tlsDir}/server.crt`,
      FAKE_TENCENTCLOUD_TLS_KEY: `${tlsDir}/server.key`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => child.kill("SIGTERM"));

  await waitForHealth(port);
  const payload = await new Promise((resolve, reject) => {
    const request = https.request({
      hostname: "127.0.0.1",
      port: tlsPort,
      method: "POST",
      path: "/",
      servername: "fake-tencentcloud.localstack-system.svc.cluster.local",
      ca: fs.readFileSync(`${tlsDir}/ca.crt`),
      headers: { "x-tc-action": "IdCardVerification" },
    }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => resolve(JSON.parse(body)));
    });
    request.once("error", reject);
    request.end("{}");
  });

  assert.equal(payload.Response.Result, "0");
});
