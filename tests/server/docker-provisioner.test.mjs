/** The docker-provisioner boundary without a Docker daemon: the real provisioner service
 * (protocol, signatures, policy, audit) over a fake Docker Engine whose "containers" are
 * in-process workspace agents serving their link in the provisioned link directory, and
 * the real Gateway composition placing a second workspace through it. */
import assert from "node:assert/strict";
import test from "node:test";
import { createConnection, createServer } from "node:net";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
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
import { defaultProvisionerPolicy } from "../../scripts/container-deployment/provisioner-application.mjs";
import {
  parseDockerProvisionerPolicy,
  serveDockerProvisioner,
} from "../../packages/sandbox-node/src/docker-provisioner-service.ts";
import {
  DOCKER_PROVISIONER_SOCKET,
  dockerProvisionerClient,
  readDockerProvisionerKey,
  signDockerProvisionerRequest,
} from "../../packages/sandbox-node/src/docker-provisioner.ts";

const budget = { cpuMillis: 4000, memoryBytes: 8 * 1024 ** 3, tasks: 4096 };
const uid = process.getuid(),
  gid = process.getgid();
const until = async (condition, ms = 10_000) => {
  const deadline = Date.now() + ms;
  while (!(await condition())) {
    if (Date.now() > deadline) throw Error("condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};
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

/** A fake Docker Engine: records every call; "starting" a container starts an in-process
 * workspace agent (terminal and files endpoints) on that workspace's link directory. */
function fakeDocker({ linkDirectory, root }) {
  const calls = [],
    containers = new Map(),
    volumes = new Map(),
    networks = new Map();
  const startAgent = async (container) => {
    const workspace = container.labels["org.opencraft.workspace"];
    // A stable run directory per workspace, like the image's fixed /run/opencraft-agent.
    const run = join(root, `agent-${workspace}`);
    await prepareAgentRunDirectory(run);
    const agent = createWorkspaceAgentSupervisor({
      runDirectory: run,
      incarnation: await createAgentIncarnation(),
      roles: ["hands"],
      log: () => {},
    });
    await agent.serveControl();
    const token = randomBytes(32).toString("hex");
    const servers = [];
    for (const name of ["terminal", "files"]) {
      const path = join(run, `${name}.sock`);
      servers.push(await echo(path));
      await agent.publishEndpoint(name, path, () => ({ token }));
    }
    agent.markReady();
    await serveAgentLink(
      agent,
      { agentLinkDirectory: join(linkDirectory, workspace), agentEndpointDirectory: join(run, "endpoints") },
      {},
      { limits: async () => budget },
    );
    container.agent = {
      incarnation: agent.incarnation.id,
      endpoints: join(run, "endpoints"),
      token,
      stop: async () => {
        await agent.stop(0);
        await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
      },
    };
  };
  const byRef = (ref) => [...containers.values()].find((c) => c.id === ref || c.name === ref);
  const docker = {
    calls,
    containers,
    volumes,
    async call(method, path, body) {
      calls.push({ method, path, body });
      const url = new URL(path, "http://docker");
      let match;
      if (method === "GET" && path === "/version") return { status: 200, body: { ApiVersion: "1.45" } };
      if (method === "GET" && (match = /^\/containers\/([^/]+)\/json$/u.exec(url.pathname))) {
        const container = byRef(match[1]);
        if (!container) return { status: 404, body: { message: "No such container" } };
        return {
          status: 200,
          body: { Id: container.id, Config: { Labels: container.labels }, State: { Running: !!container.running } },
        };
      }
      if (method === "GET" && url.pathname === "/containers/json") {
        const [label] = JSON.parse(url.searchParams.get("filters")).label;
        const [key, value] = label.split("=");
        return { status: 200, body: [...containers.values()].filter((c) => c.labels[key] === value) };
      }
      if (method === "POST" && url.pathname === "/containers/create") {
        if (body.Image !== "opencraft:test") return { status: 404, body: { message: "No such image" } };
        const container = {
          id: randomBytes(32).toString("hex"),
          name: url.searchParams.get("name"),
          labels: body.Labels,
          spec: body,
        };
        containers.set(container.name, container);
        return { status: 201, body: { Id: container.id } };
      }
      if (method === "POST" && (match = /^\/containers\/([^/]+)\/(start|stop)$/u.exec(url.pathname))) {
        const container = byRef(match[1]);
        if (!container) return { status: 404, body: {} };
        if (match[2] === "start" && !container.running) {
          container.running = true;
          await startAgent(container);
        } else if (match[2] === "stop" && container.running) {
          container.running = false;
          await container.agent.stop();
        }
        return { status: 204 };
      }
      if (method === "DELETE" && (match = /^\/containers\/([^/]+)$/u.exec(url.pathname))) {
        const container = byRef(match[1]);
        if (!container) return { status: 404, body: {} };
        if (container.running) await container.agent.stop();
        containers.delete(container.name);
        return { status: 204 };
      }
      if (method === "POST" && url.pathname === "/volumes/create") {
        if (!volumes.has(body.Name)) volumes.set(body.Name, { Name: body.Name, Labels: body.Labels });
        return { status: 201, body: volumes.get(body.Name) };
      }
      if ((match = /^\/volumes\/([^/]+)$/u.exec(url.pathname))) {
        if (!volumes.has(match[1])) return { status: 404, body: {} };
        if (method === "DELETE") {
          volumes.delete(match[1]);
          return { status: 204 };
        }
        return { status: 200, body: volumes.get(match[1]) };
      }
      if (method === "GET" && (match = /^\/networks\/([^/]+)$/u.exec(url.pathname)))
        return networks.has(match[1]) ? { status: 200, body: networks.get(match[1]) } : { status: 404, body: {} };
      if (method === "POST" && url.pathname === "/networks/create") {
        networks.set(body.Name, { Name: body.Name, Driver: body.Driver, Options: body.Options, Labels: body.Labels });
        return { status: 201, body: { Id: "net" } };
      }
      return { status: 500, body: { message: `unexpected ${method} ${path}` } };
    },
  };
  return docker;
}

const policyFor = (links, overrides = {}) => ({
  deployment: "octest",
  maxWorkspaces: 2,
  network: "oc-ws",
  links: { directory: links },
  linkDirectory: links,
  images: {
    workspace: {
      image: "opencraft:test",
      command: ["/opt/opencraft/bin/node", "/opt/opencraft/runtime/workspace-agent.mjs", "--role", "hands"],
      user: `${uid}:${gid}`,
      ...(uid === 0 ? { root: true } : {}),
      cpuMillis: budget.cpuMillis,
      memoryBytes: budget.memoryBytes,
      pidsLimit: 4096,
      volumeTarget: "/var/lib/opencraft-workspace",
      env: { OPENCRAFT_DATA_DIR: "/var/lib/opencraft-workspace/data" },
    },
  },
  ...overrides,
});

async function provisioner(t) {
  const root = await mkdtemp(join(tmpdir(), "oc-prov-"));
  const control = join(root, "control"),
    links = join(root, "links");
  await mkdir(control, { mode: 0o700 });
  await mkdir(links, { mode: 0o700 });
  const docker = fakeDocker({ linkDirectory: links, root });
  const audit = [];
  const service = await serveDockerProvisioner({
    directory: control,
    docker,
    policy: parseDockerProvisionerPolicy(policyFor(links)),
    log: (event) => audit.push(event),
  });
  t.after(async () => {
    for (const container of docker.containers.values()) if (container.running) await container.agent.stop();
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, control, links, docker, audit };
}

/** One raw line exchange with the provisioner socket. */
const raw = (control, line) =>
  new Promise((resolve, reject) => {
    const socket = createConnection(join(control, DOCKER_PROVISIONER_SOCKET));
    let text = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => (text += chunk));
    socket.on("end", () => resolve(JSON.parse(text)));
    socket.on("error", reject);
    socket.write(line + "\n");
  });

test("policy validation refuses unsafe deployments", () => {
  const links = "/srv/links";
  const image = policyFor(links).images.workspace;
  const bad = [
    { network: "host" },
    { extra: true },
    { images: { workspace: { ...image, mounts: [{ source: "/var/run/docker.sock", target: "/d", readOnly: true }] } } },
    {
      images: {
        workspace: { ...image, mounts: [{ source: "/srv/x", target: "/run/opencraft-link", readOnly: true }] },
      },
    },
    { images: { workspace: { ...image, mounts: [{ source: "/", target: "/host", readOnly: true }] } } },
    { images: { workspace: { ...image, user: "0:0", root: undefined } } },
    { images: { workspace: { ...image, privileged: true } } },
    { images: { workspace: { ...image, env: { OPENCRAFT_AGENT_LINK_DIR: "/tmp" } } } },
    { images: { "Bad Alias": image } },
  ];
  for (const overrides of bad) assert.throws(() => parseDockerProvisionerPolicy(policyFor(links, overrides)));
  const policy = defaultProvisionerPolicy({
    OPENCRAFT_UID: "1000",
    OPENCRAFT_GID: "1000",
    OPENCRAFT_PROVISIONER_LINK_VOLUME: "opencraft-workspace-links",
    OPENCRAFT_PROVISIONER_WORKSPACE_IMAGE: "opencraft:local",
  });
  assert.equal(parseDockerProvisionerPolicy(policy).images.workspace.user, "1000:1000");
});

test("the provisioner accepts only signed, fresh, allow-listed requests and audits every one", async (t) => {
  const { control, docker, audit } = await provisioner(t);
  const key = await readDockerProvisionerKey(control);
  assert.equal((await stat(join(control, "request.key"))).mode & 0o777, 0o600);
  assert.equal((await stat(join(control, DOCKER_PROVISIONER_SOCKET))).mode & 0o777, 0o600);
  const signed = (request, at) => JSON.stringify(signDockerProvisionerRequest(key, request, at));
  const refused = async (line, code) => {
    const answer = await raw(control, line);
    assert.equal(answer.ok, false, line);
    assert.equal(answer.code, code, line);
  };
  const calls = docker.calls.length;
  const valid = signDockerProvisionerRequest(key, { op: "inspect", workspace: "ws-a" });
  await refused(JSON.stringify({ ...valid, mac: undefined }), "unauthenticated");
  await refused(JSON.stringify({ ...valid, mac: "0".repeat(64) }), "unauthenticated");
  await refused(JSON.stringify({ ...valid, workspace: "ws-b" }), "unauthenticated");
  await refused(signed({ op: "inspect", workspace: "ws-a" }, Date.now() - 120_000), "unauthenticated");
  await refused(JSON.stringify({ ...valid, cmd: ["sh"] }), "malformed");
  await refused(signed({ op: "run", workspace: "ws-a" }), "malformed");
  await refused(signed({ op: "inspect", workspace: "../etc" }), "malformed");
  await refused(signed({ op: "ensure", workspace: "ws-a", image: "alpine:latest" }), "malformed");
  await refused("not json", "malformed");
  assert.equal(docker.calls.length, calls, "refused requests never reach Docker");
  // A valid request is answered once; the same signed line again is a replay.
  assert.equal((await raw(control, JSON.stringify(valid))).ok, true);
  await refused(JSON.stringify(valid), "unauthenticated");
  // Allow-list: an unknown alias is refused after authentication.
  await refused(signed({ op: "ensure", workspace: "ws-a", image: "other" }), "image");
  assert.ok(
    audit.every((event) => event.type !== "docker-provisioner-audit" || (!("mac" in event) && !("nonce" in event))),
  );
  assert.ok(audit.filter((event) => event.outcome === "refused").length >= 10);
  // A same-named container this deployment did not create is never touched.
  docker.containers.set("octest-ws-foreign", {
    id: "f".repeat(64),
    name: "octest-ws-foreign",
    labels: { "org.opencraft.provisioner": "someone-else" },
  });
  await refused(signed({ op: "destroy", workspace: "foreign" }), "foreign");
  assert.ok(docker.containers.has("octest-ws-foreign"));
});

test("ensure creates the container only from policy, with fixed confinement and its own link", async (t) => {
  const { control, links, docker } = await provisioner(t);
  const client = dockerProvisionerClient({ directory: control });
  const container = await client.request("ensure", "ws-a", "workspace");
  assert.equal(container.state, "running");
  const created = docker.calls.find((call) => call.path.startsWith("/containers/create")).body;
  assert.equal(created.Image, "opencraft:test");
  assert.equal(created.User, `${uid}:${gid}`);
  assert.deepEqual(created.HostConfig.CapDrop, ["ALL"]);
  assert.deepEqual(created.HostConfig.SecurityOpt, ["no-new-privileges:true"]);
  assert.equal(created.HostConfig.Privileged, false);
  assert.equal(created.HostConfig.NanoCpus, 4e9);
  assert.equal(created.HostConfig.Memory, budget.memoryBytes);
  assert.equal(created.HostConfig.MemorySwap, budget.memoryBytes);
  assert.equal(created.HostConfig.PidsLimit, 4096);
  assert.equal(created.HostConfig.NetworkMode, "oc-ws");
  assert.deepEqual(
    created.HostConfig.Mounts.map((mount) => [mount.Type, mount.Source, mount.Target]),
    [
      ["volume", "octest-ws-ws-a-data", "/var/lib/opencraft-workspace"],
      ["bind", join(links, "ws-a"), "/run/opencraft-link"],
    ],
  );
  assert.ok(!JSON.stringify(created).includes("docker.sock"));
  assert.equal((await stat(join(links, "ws-a"))).mode & 0o777, 0o700);
  const network = await docker.call("GET", "/networks/oc-ws");
  assert.equal(network.body.Options["com.docker.network.bridge.enable_icc"], "false");
  // Idempotent per workspace; another alias for a placed workspace is refused.
  assert.equal((await client.request("ensure", "ws-a", "workspace")).id, container.id);
  // Capacity: maxWorkspaces = 2.
  await client.request("ensure", "ws-b", "workspace");
  await assert.rejects(client.request("ensure", "ws-c", "workspace"), { code: "capacity" });
  assert.equal((await client.request("stop", "ws-a")).state, "stopped");
  assert.equal((await client.request("destroy", "ws-a")).state, "absent");
  assert.equal(docker.volumes.has("octest-ws-ws-a-data"), false);
  await assert.rejects(access(join(links, "ws-a")), { code: "ENOENT" });
  assert.equal((await client.request("inspect", "ws-a")).state, "absent");
});

test(
  "the Gateway places a second workspace through docker-provisioner: create, re-attach, sleep and wake, discard",
  { timeout: 120_000 },
  async (t) => {
    const { root, control, links, docker } = await provisioner(t);
    const data = join(root, "data"),
      run = join(root, "gateway-run");
    await mkdir(data, { mode: 0o700 });
    await mkdir(run, { mode: 0o700 });
    // The default workspace keeps its static-docker placement (an in-process agent here).
    const defaultRun = join(root, "default-run"),
      defaultLink = join(root, "static-links", "hands");
    await mkdir(defaultLink, { recursive: true, mode: 0o700 });
    await prepareAgentRunDirectory(defaultRun);
    const hands = createWorkspaceAgentSupervisor({
      runDirectory: defaultRun,
      incarnation: await createAgentIncarnation(),
      roles: ["hands"],
      log: () => {},
    });
    await hands.serveControl();
    const defaultToken = randomBytes(32).toString("hex");
    const servers = [];
    for (const name of ["terminal", "files"]) {
      servers.push(await echo(join(defaultRun, `${name}.sock`)));
      await hands.publishEndpoint(name, join(defaultRun, `${name}.sock`), () => ({ token: defaultToken }));
    }
    hands.markReady();
    await serveAgentLink(
      hands,
      { agentLinkDirectory: defaultLink, agentEndpointDirectory: join(defaultRun, "endpoints") },
      {},
      { limits: async () => budget },
    );
    t.after(async () => {
      await hands.stop(0);
      await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
    });
    const events = [];
    const env = {
      OPENCRAFT_WORKSPACE_LINK_ROOT: join(root, "static-links"),
      OPENCRAFT_WORKSPACE_ENVIRONMENTS: "static-docker://hands",
      OPENCRAFT_WORKSPACE_PROVISIONED_ENVIRONMENTS: "docker-provisioner://workspace",
      OPENCRAFT_PROVISIONER_DIR: control,
      OPENCRAFT_WORKSPACE_PROVISIONED_LINK_ROOT: links,
      OPENCRAFT_GATEWAY_RUN_DIR: run,
    };
    const agentOf = (workspace) => docker.containers.get(`octest-ws-${workspace}`)?.agent;
    // In-process agents publish endpoints outside the image's fixed directory.
    const endpointDirectories = {
      hands: join(defaultRun, "endpoints"),
      workspace: join(root, "agent-ws-two", "endpoints"),
    };
    const open = () =>
      openGatewayWorkspace({ dataDirectory: data, env, endpointDirectories, log: (event) => events.push(event) });
    const changes = () =>
      events
        .splice(0)
        .filter((event) => event.type === "workspace-placement" && event.workspace === "ws-two")
        .map((event) => event.change);
    const roundTrip = async (path, text) => {
      const socket = createConnection({ path, allowHalfOpen: true });
      await once(socket, "connect");
      let received = "";
      socket.on("data", (chunk) => (received += chunk));
      socket.write(text);
      await until(() => received === text);
      socket.destroy();
    };

    let gateway = await open();
    t.after(() => gateway.close().catch(() => {}));
    await assert.rejects(gateway.workspaces.open("Bad/Id"), /Invalid workspace id/u);
    let second = await gateway.workspaces.open("ws-two");
    assert.deepEqual(gateway.workspaces.ids(), ["default", "ws-two"]);
    assert.equal(second.sockets.terminal, join(run, "workspaces", "ws-two", "endpoints", "terminal"));
    await roundTrip(second.sockets.terminal, "second workspace terminal");
    await roundTrip(gateway.sockets.terminal, "default workspace terminal");
    const first = agentOf("ws-two").incarnation;
    assert.equal((await readFile(second.tokenFiles.terminal, "utf8")).trim(), agentOf("ws-two").token);
    assert.deepEqual(changes(), ["created"]);
    const placement = JSON.parse(await readFile(join(data, "workspaces", "ws-two", "host", "placement.json"), "utf8"));
    const container = docker.containers.get("octest-ws-ws-two");
    assert.deepEqual(placement["docker-provisioner://workspace"].receipt, {
      backend: "docker-provisioner",
      instanceId: `${container.id}:${first}`,
    });

    // A Gateway restart re-attaches the same container and incarnation by receipt.
    await gateway.close();
    assert.deepEqual(changes(), ["released"]);
    assert.equal(container.running, true, "closing the Gateway leaves the workspace container running");
    gateway = await open();
    second = await gateway.workspaces.open("ws-two");
    await roundTrip(second.sockets.terminal, "after Gateway restart");
    assert.deepEqual(changes(), ["attached"]);
    assert.equal(agentOf("ws-two").incarnation, first);

    // Idle sleep stops the container (volume kept); the next use wakes it as a new incarnation.
    assert.deepEqual(await gateway.workspaces.sleep("ws-two"), [
      { environment: "docker-provisioner://workspace", slept: true },
    ]);
    assert.equal(container.running, false);
    assert.ok(docker.volumes.has("octest-ws-ws-two-data"));
    assert.deepEqual(changes(), ["released"]);
    await roundTrip(second.sockets.terminal, "woken");
    assert.notEqual(agentOf("ws-two").incarnation, first);
    assert.equal(docker.containers.get("octest-ws-ws-two").id, container.id, "waking restarts the same container");
    assert.deepEqual(changes(), ["attach-failed", "created"]);
    // The default static-docker workspace cannot sleep: it stays resident.
    assert.deepEqual(await gateway.workspaces.sleep("default"), [
      { environment: "static-docker://hands", slept: false },
    ]);

    // Discard removes the container, its volume and its link, and forgets the receipt.
    await gateway.workspaces.discard("ws-two");
    assert.equal(docker.containers.has("octest-ws-ws-two"), false);
    assert.equal(docker.volumes.has("octest-ws-ws-two-data"), false);
    await assert.rejects(access(join(links, "ws-two")), { code: "ENOENT" });
    await assert.rejects(access(join(run, "workspaces", "ws-two")), { code: "ENOENT" });
    assert.deepEqual(
      JSON.parse(await readFile(join(data, "workspaces", "ws-two", "host", "placement.json"), "utf8"))[
        "docker-provisioner://workspace"
      ],
      {},
    );
    assert.deepEqual(gateway.workspaces.ids(), ["default"]);
    await gateway.close();
  },
);
