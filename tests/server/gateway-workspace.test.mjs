/** The Docker Gateway reaches Brain and Hands owners only as `workspace://default/
 * endpoints/<name>` through the static-docker provider: real workspace agents with
 * their link servers in this process, no container and no Docker socket. */
import assert from "node:assert/strict";
import test from "node:test";
import { createServer as createHttpServer } from "node:http";
import { createConnection, createServer } from "node:net";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  createAgentIncarnation,
  createWorkspaceAgentSupervisor,
  prepareAgentRunDirectory,
} from "../../scripts/container-deployment/workspace-agent-supervisor.mjs";
import { serveAgentLink } from "../../scripts/container-deployment/workspace-agent-application.mjs";
import { openGatewayWorkspace } from "../../scripts/container-deployment/gateway-workspace.mjs";
import { readEngineHostIdentity } from "../../apps/headless-server/src/server-deployment/engine-host-client.mjs";

const budget = { cpuMillis: 4000, memoryBytes: 8 * 1024 ** 3, tasks: 4096 };
const listen = async (server, path) => {
  server.listen(path);
  await once(server, "listening");
  return server;
};
const echo = (path) =>
  listen(
    createServer({ allowHalfOpen: true }, (socket) => {
      socket.on("data", (data) => socket.write(data));
      socket.on("end", () => socket.end());
      socket.on("error", () => {});
    }),
    path,
  );
const until = async (condition, ms = 10_000) => {
  const deadline = Date.now() + ms;
  while (!(await condition())) {
    if (Date.now() > deadline) throw Error("condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

/** One fake workspace container: an agent whose owners are published endpoints, plus its static-docker link. */
async function container(root, service, owners) {
  const run = join(root, `${service}-run`),
    link = join(root, "links", service);
  await mkdir(link, { recursive: true, mode: 0o700 });
  await prepareAgentRunDirectory(run);
  const agent = createWorkspaceAgentSupervisor({
    runDirectory: run,
    incarnation: await createAgentIncarnation(),
    roles: [service],
    log: () => {},
  });
  await agent.serveControl();
  const servers = [];
  for (const [name, make, describe] of owners(run)) {
    const path = join(run, `${name}.sock`);
    servers.push(await make(path));
    await agent.publishEndpoint(name, path, describe);
  }
  agent.markReady();
  await serveAgentLink(
    agent,
    { agentLinkDirectory: link, agentEndpointDirectory: join(run, "endpoints") },
    {},
    { limits: async () => budget },
  );
  return {
    incarnation: agent.incarnation.id,
    endpoints: join(run, "endpoints"),
    async stop() {
      await agent.stop(0);
      await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
    },
  };
}

test(
  "the Gateway reaches Brain/Hands owners only as workspace endpoints, re-attaches after its restart and rebinds a new incarnation",
  { timeout: 120_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "oc-gw-"));
    const data = join(root, "data");
    await mkdir(data, { mode: 0o700 });
    t.after(() => rm(root, { recursive: true, force: true }));
    const controlToken = randomBytes(32).toString("hex"),
      terminalToken = randomBytes(32).toString("hex"),
      piToken = randomBytes(16).toString("hex");
    const brainOwners = (run) => [
      [
        "codex-control",
        (path) =>
          listen(
            createHttpServer((request, response) => {
              if (request.headers.authorization !== `Bearer ${controlToken}`) {
                response.writeHead(401).end("{}");
                return;
              }
              response.end(
                JSON.stringify({
                  protocolVersion: 1,
                  pid: 41,
                  codexPid: 42,
                  nativeSocket: join(run, "codex-native.sock"),
                }),
              );
            }),
            path,
          ),
        () => ({ token: controlToken }),
      ],
      ["codex-native", echo],
      [
        "pi",
        (path) =>
          listen(
            createHttpServer((request, response) => {
              if (request.url !== "/health" || request.headers.authorization !== `Bearer ${piToken}`) {
                response.writeHead(403).end();
                return;
              }
              response.end(
                JSON.stringify({
                  ok: true,
                  protocolVersion: 1,
                  pid: 43,
                  machineId: "machine",
                  engines: ["dsh", "pi"],
                  defaultEngine: "pi",
                }),
              );
            }),
            path,
          ),
        () => ({
          schemaVersion: 1,
          pid: 43,
          machineId: "machine",
          dataDirectory: data,
          engines: ["dsh", "pi"],
          defaultEngine: "pi",
          websocketUrl: `ws+unix://${join(run, "pi.sock")}:/rpc?token=${piToken}`,
          token: piToken,
        }),
      ],
    ];
    const handsOwners = () => [
      ["terminal", echo, () => ({ token: terminalToken })],
      ["files", echo, () => ({ token: terminalToken })],
      ["browser", echo],
    ];
    const brain = await container(root, "brain", brainOwners);
    let hands = await container(root, "hands", handsOwners);
    t.after(() => Promise.allSettled([brain.stop(), hands.stop()]));
    const events = [];
    const open = () =>
      openGatewayWorkspace({
        dataDirectory: data,
        env: { OPENCRAFT_WORKSPACE_LINK_ROOT: join(root, "links") },
        endpointDirectories: { brain: brain.endpoints, hands: hands.endpoints },
        log: (event) => events.push(event),
      });
    const changes = () =>
      events
        .splice(0)
        .filter((event) => event.type === "workspace-placement")
        .map((event) => `${event.environment} ${event.change}`)
        .sort();
    const roundTrip = async (path, text) => {
      const socket = createConnection({ path, allowHalfOpen: true });
      await once(socket, "connect");
      let received = "";
      socket.on("data", (data) => {
        received += data;
      });
      socket.write(text);
      await until(() => received === text);
      socket.destroy();
    };

    let workspace = await open();
    t.after(() => workspace.close().catch(() => {}));
    await roundTrip(workspace.sockets.terminal, "terminal bytes");
    await roundTrip(workspace.sockets["codex-native"], "native bytes");
    await roundTrip(workspace.sockets.browser, "browser bytes");
    assert.equal((await workspace.codexHealth()).codexPid, 42);
    // The engine descriptor's in-environment socket is replaced by the Gateway's private listener.
    assert.match(
      (await workspace.piDescriptor()).websocketUrl,
      new RegExp(`^ws\\+unix://${workspace.sockets.pi}:/rpc\\?token=`),
    );
    assert.deepEqual(await readEngineHostIdentity(workspace.piDescriptor), { pid: 43 });
    assert.equal((await readFile(workspace.tokenFiles.terminal, "utf8")).trim(), terminalToken);
    assert.deepEqual(changes(), ["static-docker://brain created", "static-docker://hands created"]);
    const placement = JSON.parse(await readFile(join(data, "workspaces", "default", "host", "placement.json"), "utf8"));
    assert.deepEqual(placement["static-docker://hands"], {
      receipt: { backend: "static-docker", instanceId: hands.incarnation },
      agentIncarnation: hands.incarnation,
    });
    await workspace.close();
    assert.deepEqual(changes(), ["static-docker://brain released", "static-docker://hands released"]);

    // A Gateway restart re-attaches the same incarnations by receipt; nothing restarts in the containers.
    workspace = await open();
    await roundTrip(workspace.sockets.terminal, "after Gateway restart");
    await workspace.observe();
    assert.deepEqual(changes(), ["static-docker://brain attached", "static-docker://hands attached"]);

    // Hands restarts (new incarnation): its receipt no longer attaches; the binding is
    // recreated and the change is reported. Brain is untouched.
    await hands.stop();
    hands = await container(root, "hands", handsOwners);
    await workspace.observe();
    assert.deepEqual(changes(), [
      "static-docker://hands attach-failed",
      "static-docker://hands created",
      "static-docker://hands released",
    ]);
    assert.equal(
      JSON.parse(await readFile(join(data, "workspaces", "default", "host", "placement.json"), "utf8"))[
        "static-docker://hands"
      ].agentIncarnation,
      hands.incarnation,
    );
    await roundTrip(workspace.sockets.terminal, "new Hands incarnation");
    await workspace.close();

    // The shared run directory is never consulted for Brain/Hands owners: it does not exist.
    await assert.rejects(access(join(data, "run")), { code: "ENOENT" });
  },
);

test("the Gateway composition holds no shared-directory paths for Brain/Hands owners", async () => {
  // Guard: the Gateway entry and its workspace composition never name the 4b descriptors,
  // native sockets or Hands owner sockets; only AccountCore paths remain (§5).
  for (const file of ["gateway-application.mjs", "gateway-workspace.mjs"]) {
    const source = await readFile(new URL(`../../scripts/container-deployment/${file}`, import.meta.url), "utf8");
    for (const forbidden of [
      "paths.engineDescriptor",
      "paths.dshDescriptor",
      "paths.appServerEndpoint",
      "paths.appServerNativeSocket",
      "paths.terminalToken",
      "paths.fileSystemToken",
      "paths.terminalEndpoint",
      "paths.fileSystemEndpoint",
      "paths.terminalDirectory",
      "paths.runDirectory",
      "paths.handsExecution",
      "native.sock",
      "terminal.sock",
      "files.sock",
      "owner.sock",
      "engine-host.json",
      "dsh-host.json",
      "OPENCRAFT_BROWSER_OWNER_SOCKET",
      "coreHealth",
    ])
      assert.equal(source.includes(forbidden), false, `${file} names ${forbidden}`);
  }
});
