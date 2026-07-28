import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

const children = new Set();
const servers = new Set();
const temporaryDirectories = new Set();

afterEach(async () => {
  for (const child of children) {
    child.kill("SIGTERM");
  }
  children.clear();
  await Promise.all(
    [...servers].map(
      (server) =>
        new Promise((resolve) => {
          server.close(resolve);
        }),
    ),
  );
  servers.clear();
  await Promise.all(
    [...temporaryDirectories].map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
  temporaryDirectories.clear();
});

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  servers.add(server);
  return server.address().port;
}

async function waitForHealth(url) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/healthz`);
      if (response.ok) {
        return;
      }
    } catch {
      // The child process may still be binding its port.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`fake jifei did not become healthy at ${url}`);
}

async function waitFor(predicate) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail("timed out waiting for fake jifei callbacks");
}

async function postInterface(baseURL, interfaceName, para) {
  const response = await fetch(baseURL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      version: "1.0",
      eventId: Date.now(),
      interface: { interfaceName, para },
    }),
  });
  assert.equal(response.status, 200);
  return response.json();
}

function spawnJifei(port, callbackURL, databasePath) {
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: new URL(".", import.meta.url),
    env: {
      ...process.env,
      FAKE_JIFEI_PORT: String(port),
      FAKE_JIFEI_CALLBACK_URL: callbackURL,
      FAKE_JIFEI_DATABASE_PATH: databasePath,
    },
    stdio: "ignore",
  });
  children.add(child);
  return child;
}

async function stopChild(child) {
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  await exited;
  children.delete(child);
}

test("zero-charge payment triggers checkCreate then createResource callbacks", async () => {
  const callbacks = [];
  const callbackServer = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const callback = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    callbacks.push(callback);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        returnCode: 0,
        returnValue: 0,
        returnMessage: "success",
        data:
          callback.interface.interfaceName === "lightvela.pass.checkCreate"
            ? { status: 0 }
            : { resourceIds: ["pass-local-test"] },
      }),
    );
  });
  const callbackPort = await listen(callbackServer);

  const placeholderServer = http.createServer();
  const jifeiPort = await listen(placeholderServer);
  await new Promise((resolve) => placeholderServer.close(resolve));
  servers.delete(placeholderServer);

  const temporaryDirectory = await mkdtemp(
    path.join(tmpdir(), "fake-jifei-test-"),
  );
  temporaryDirectories.add(temporaryDirectory);
  spawnJifei(
    jifeiPort,
    `http://127.0.0.1:${callbackPort}/trade/jifei/callback`,
    path.join(temporaryDirectory, "jifei.sqlite"),
  );

  const baseURL = `http://127.0.0.1:${jifeiPort}`;
  await waitForHealth(baseURL);

  const goodsDetail = {
    bundleId: "bundle_general_local",
    externalUserId: "user-local-test",
    goodsNum: 1,
    pid: 1000001,
    productCode: "p_lighthouse",
    subProductCode: "sp_lighthouse_local_standard",
    sv_lighthouse_agent_quota: 3,
    timeSpan: 1,
    timeUnit: "m",
  };
  const order = await postInterface(baseURL, "qcloud.Deal.generateDeals", {
    ownerUin: "700000164995",
    uin: "700000164995",
    appId: 251202221,
    goods: [
      {
        goodsCategoryId: 100059,
        regionId: 1,
        zoneId: 100001,
        goodsNum: 1,
        payMode: 1,
        projectId: 0,
        goodsDetail,
      },
    ],
  });
  const dealName = order.data.dealNames[0];

  const payment = await postInterface(
    baseURL,
    "qcloud.margin.getMidasEarmarking",
    {
      ownerUin: "700000164995",
      uin: "700000164995",
      dealNames: [dealName],
      wxOpenId: "local-wechat-openid",
    },
  );
  assert.equal(payment.data.needCharge, 0);

  await waitFor(() => callbacks.length === 2);
  assert.deepEqual(
    callbacks.map((callback) => callback.interface.interfaceName),
    ["lightvela.pass.checkCreate", "lightvela.pass.createResource"],
  );
  assert.equal(callbacks[0].interface.para.appId, 251202221);
  assert.equal(callbacks[0].interface.para.region, 1);
  assert.equal(callbacks[0].interface.para.zoneId, 100001);
  assert.deepEqual(callbacks[0].interface.para.goodsDetail, goodsDetail);
  assert.equal(callbacks[1].interface.para.dealName, dealName);
  assert.equal(callbacks[1].interface.para.uin, "700000164995");
  assert.deepEqual(callbacks[1].interface.para.goodsDetail, goodsDetail);
});

test("deal context survives a fake jifei restart", async () => {
  const callbacks = [];
  const callbackServer = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    callbacks.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        returnCode: 0,
        returnValue: 0,
        returnMessage: "success",
        data: {},
      }),
    );
  });
  const callbackPort = await listen(callbackServer);
  const callbackURL = `http://127.0.0.1:${callbackPort}/trade/jifei/callback`;

  const placeholderServer = http.createServer();
  const jifeiPort = await listen(placeholderServer);
  await new Promise((resolve) => placeholderServer.close(resolve));
  servers.delete(placeholderServer);

  const temporaryDirectory = await mkdtemp(
    path.join(tmpdir(), "fake-jifei-restart-test-"),
  );
  temporaryDirectories.add(temporaryDirectory);
  const databasePath = path.join(temporaryDirectory, "jifei.sqlite");

  const firstProcess = spawnJifei(jifeiPort, callbackURL, databasePath);
  const baseURL = `http://127.0.0.1:${jifeiPort}`;
  await waitForHealth(baseURL);
  const order = await postInterface(baseURL, "qcloud.Deal.generateDeals", {
    ownerUin: "700000164995",
    uin: "700000164995",
    appId: 251202221,
    goods: [
      {
        goodsCategoryId: 100059,
        regionId: 1,
        zoneId: 100001,
        goodsNum: 1,
        payMode: 1,
        projectId: 0,
        goodsDetail: {
          bundleId: "bundle_general_local",
          externalUserId: "user-local-restart-test",
          goodsNum: 1,
          pid: 1000001,
          productCode: "p_lighthouse",
          subProductCode: "sp_lighthouse_local_standard",
          timeSpan: 1,
          timeUnit: "m",
        },
      },
    ],
  });
  const dealName = order.data.dealNames[0];
  await stopChild(firstProcess);

  spawnJifei(jifeiPort, callbackURL, databasePath);
  await waitForHealth(baseURL);
  await postInterface(baseURL, "qcloud.margin.getMidasEarmarking", {
    ownerUin: "700000164995",
    uin: "700000164995",
    dealNames: [dealName],
  });

  await waitFor(() => callbacks.length === 2);
  assert.equal(
    callbacks[1].interface.para.goodsDetail.externalUserId,
    "user-local-restart-test",
  );
});
