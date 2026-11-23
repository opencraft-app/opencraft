import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { parseRelayConfiguration, startRelayApplication } from "../../apps/relay-server/src/application";
import { addressBytes, createSourceAllowList, parseCidr } from "../../apps/relay-server/src/cidr";
import { HUB_ENROLLMENT_PATH } from "../../apps/relay-server/src/source-enrollment";
import { openHubNetwork } from "../../packages/hub-network/src/open";
import { parseInvitation, random, signed } from "../../packages/hub-network/src/store";

const token = () => randomBytes(32).toString("base64url");
async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((r) => server.close(() => r()));
  return port;
}

test("CIDR parsing is strict for IPv4 and IPv6 and matching normalizes mapped addresses", () => {
  for (const bad of [
    "10.0.0.1/8",
    "10.0.0.0/33",
    "10.0.0.0/08",
    "10.0.0.0/0",
    "::/0",
    "10.0.0.0",
    "/8",
    "10.0.0/8",
    "2001:db8::1/32",
    "2001:db8::/129",
    "fe80::%eth0/64",
    " 10.0.0.0/8",
    "10.0.0.0/8 ",
    "example.test/24",
    42,
    null,
  ])
    assert.throws(() => parseCidr(bad), String(bad));
  assert.equal(parseCidr("10.0.0.0/8").prefix, 8);
  assert.equal(parseCidr("2001:db8::/32").bytes.length, 16);
  assert.equal(parseCidr("192.0.2.7/32").prefix, 32);
  assert.equal(Buffer.from(addressBytes("::ffff:192.0.2.1")!).toString("hex"), "c0000201");
  assert.equal(Buffer.from(addressBytes("64:ff9b::192.0.2.1")!).toString("hex"), "0064ff9b0000000000000000c0000201");
  assert.equal(Buffer.from(addressBytes("2001:db8::1")!).toString("hex"), "20010db8000000000000000000000001");
  for (const bad of ["", "192.0.2.256", "1:2:3:4:5:6:7:8:9", "fe80::1%eth0", "192.0.2.1, 198.51.100.1", undefined])
    assert.equal(addressBytes(bad), null, String(bad));
  const allow = createSourceAllowList(["10.0.0.0/8", "192.0.2.128/25", "2001:db8:1::/48"]);
  for (const [address, canonical] of [
    ["10.1.2.3", "10.1.2.3"],
    ["::ffff:10.255.0.1", "10.255.0.1"],
    ["192.0.2.200", "192.0.2.200"],
    ["2001:db8:1:ffff::1", "2001:db8:1:ffff::1"],
    ["2001:DB8:1::2", "2001:db8:1::2"],
  ] as const)
    assert.equal(allow(address), canonical, address);
  for (const address of [
    "172.16.0.1",
    "192.0.2.127",
    "2001:db8:2::1",
    "::1",
    "127.0.0.1",
    "::ffff:172.16.0.1",
    "::a00:1",
    undefined,
  ])
    assert.equal(allow(address), null, String(address));
});

test("source enrollment configuration requires a relay-terminated TLS listener and valid networks", async () => {
  const base = { schemaVersion: 1, host: "127.0.0.1", port: await freePort(), routes: [] };
  const hub = { stateFile: "/private/hub.json", operatorCredentialFile: "/private/operator.json" };
  const peer = { ...hub, port: base.port + 1, tlsCertFile: "/private/cert.pem", tlsKeyFile: "/private/key.pem" };
  parseRelayConfiguration({
    ...base,
    hubNetwork: { ...peer, sourceEnrollment: { cidrs: ["10.0.0.0/8", "2001:db8::/32"] } },
  });
  parseRelayConfiguration({
    ...base,
    tlsCertFile: "/private/cert.pem",
    tlsKeyFile: "/private/key.pem",
    hubNetwork: { ...hub, sourceEnrollment: { cidrs: ["10.0.0.0/8"] } },
  });
  for (const bad of [
    { ...base, hubNetwork: { ...hub, sourceEnrollment: { cidrs: ["10.0.0.0/8"] } } },
    {
      ...base,
      host: "0.0.0.0",
      tlsTermination: "trusted-proxy",
      hubNetwork: { ...hub, sourceEnrollment: { cidrs: ["10.0.0.0/8"] } },
    },
    { ...base, hubNetwork: { ...peer, sourceEnrollment: { cidrs: [] } } },
    { ...base, hubNetwork: { ...peer, sourceEnrollment: { cidrs: ["0.0.0.0/0"] } } },
    { ...base, hubNetwork: { ...peer, sourceEnrollment: { cidrs: ["10.0.0.1/8"] } } },
    { ...base, hubNetwork: { ...peer, sourceEnrollment: { cidrs: ["10.0.0.0/8"], trustForwarded: true } } },
    { ...base, hubNetwork: { ...peer, sourceEnrollment: ["10.0.0.0/8"] } },
  ])
    assert.throws(() => parseRelayConfiguration(bad), JSON.stringify(bad));
});

async function fixture(t: test.TestContext, cidrs: string[]) {
  const dir = await mkdtemp(join(tmpdir(), "relay-source-enrollment-"));
  const cert = join(dir, "cert.pem"),
    key = join(dir, "key.pem"),
    operatorFile = join(dir, "operator.json"),
    credential = token();
  await promisify(execFile)("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "1",
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=IP:127.0.0.1,DNS:localhost",
    "-keyout",
    key,
    "-out",
    cert,
  ]);
  await writeFile(operatorFile, JSON.stringify({ credential }), { mode: 0o600 });
  const ca = await readFile(cert, "utf8"),
    port = await freePort(),
    peerPort = await freePort();
  const app = await startRelayApplication({
    schemaVersion: 1,
    host: "127.0.0.1",
    port,
    routes: [],
    hubNetwork: {
      stateFile: join(dir, "hub.json"),
      operatorCredentialFile: operatorFile,
      caFile: cert,
      tlsCertFile: cert,
      tlsKeyFile: key,
      port: peerPort,
      sourceEnrollment: { cidrs },
    },
  });
  const owned: { client?: Awaited<ReturnType<typeof openHubNetwork>> } = {};
  t.after(async () => {
    await owned.client?.close();
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });
  const operator = (method: "GET" | "POST", body?: unknown) =>
    new Promise<any>((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: "127.0.0.1",
          port,
          path: "/__opencraft_hub/operator",
          method,
          agent: false,
          headers: { authorization: "Bearer " + credential, "content-type": "application/json" },
        },
        (res) => {
          let text = "";
          res.on("data", (c) => (text += c));
          res.on("end", () =>
            res.statusCode === 200 ? resolve(JSON.parse(text)) : reject(new Error(String(res.statusCode))),
          );
        },
      );
      req.once("error", reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  const endpoint = `https://127.0.0.1:${peerPort}`;
  const snapshot = await operator("GET");
  await operator("POST", {
    action: "configure",
    revision: snapshot.revision,
    name: "Fixture Relay",
    endpoint,
    origin: "",
    accepting: true,
    forwarding: true,
  });
  owned.client = await openHubNetwork(join(dir, "client.json"));
  const node = owned.client.node;
  const proof = (origin = "") => {
    const value = {
      audience: "opencraft-hub-enrollment.v1",
      relay: endpoint,
      hubId: node.store.id,
      publicKey: node.store.state.publicKey,
      origin,
      timestamp: Date.now(),
      nonce: random(),
    };
    return { ...value, signature: signed(value, node.store.state.privateKey) };
  };
  const post = (body: unknown, headers: Record<string, string> = {}, target = endpoint) =>
    new Promise<{ status: number; body: any }>((resolve, reject) => {
      const send = target.startsWith("https:") ? httpsRequest : httpRequest;
      const req = send(
        target + HUB_ENROLLMENT_PATH,
        { method: "POST", ca, agent: false, headers: { "content-type": "application/json", ...headers } },
        (res) => {
          let text = "";
          res.on("data", (c) => (text += c));
          res.on("end", () => resolve({ status: res.statusCode!, body: text ? JSON.parse(text) : null }));
        },
      );
      req.once("error", reject);
      req.end(JSON.stringify(body));
    });
  return { app, node, endpoint, ca, proof, post, operator, publicEndpoint: `http://127.0.0.1:${port}` };
}

test("a machine inside a configured network joins by address over the direct TLS peer listener", async (t) => {
  const f = await fixture(t, ["127.0.0.0/8"]);
  const result = await f.node.connectEndpoint(f.endpoint, { ca: f.ca }, "fixture");
  assert.ok(!("conflict" in result));
  const snapshot = await f.operator("GET");
  assert.equal(
    snapshot.audit.find((entry: { action: string }) => entry.action === "enroll")?.operator,
    "source-ip:127.0.0.1",
  );
  assert.equal(f.node.store.state.peers.length, 1);

  const proof = f.proof(),
    first = await f.post(proof);
  assert.equal(first.status, 200);
  assert.equal(parseInvitation(first.body.invitation).hubId, (await f.operator("GET")).hubId);
  assert.deepEqual(await f.post(proof), { status: 409, body: { error: "replayed_request" } });
  assert.deepEqual(
    await f.post(f.proof(), { origin: "https://browser.example" }),
    { status: 403, body: { error: "source_denied" } },
    "browser requests never enroll",
  );
  assert.equal((await f.post({ ...f.proof(), relay: "https://other.example" })).status, 400);
  assert.equal((await f.post({ ...f.proof(), timestamp: Date.now() - 600_000 })).status, 400);
  assert.equal((await f.post({ ...f.proof(), signature: "invalid" })).status, 403);
  assert.equal((await f.post({ ...f.proof(), extra: true })).status, 400);
  assert.deepEqual(
    await f.post(f.proof(), {}, f.publicEndpoint),
    { status: 403, body: { error: "source_denied" } },
    "plain HTTP is not a source authority",
  );
});

test("a source outside the configured networks is denied and forwarded headers never widen it", async (t) => {
  const f = await fixture(t, ["10.0.0.0/8", "2001:db8::/32"]);
  for (const headers of [
    { "x-forwarded-for": "10.1.2.3" },
    { forwarded: "for=10.1.2.3" },
    { "x-real-ip": "10.1.2.3" },
    {},
  ])
    assert.deepEqual(
      await f.post(f.proof(), headers),
      { status: 403, body: { error: "source_denied" } },
      JSON.stringify(headers),
    );
  await assert.rejects(f.node.connectEndpoint(f.endpoint, { ca: f.ca }, "fixture"), /denied/);
  assert.equal(
    (await f.operator("GET")).audit.some((entry: { action: string }) => entry.action === "enroll"),
    false,
  );
});
