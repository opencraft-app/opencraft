import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import test from "node:test";
import { SshCodexTransport, buildCodexProxyCommand } from "../../apps/opencraft-daemon/src/ssh-codex-transport.js";
import { readSshCodexServerBindings } from "../../apps/opencraft-daemon/src/ssh-codex-connections.js";
import { parseSshServerDescriptors } from "@opencraft/app-host-protocol";

const fixture = new URL("../fixtures/fake-codex-ssh-proxy.mjs", import.meta.url).pathname;
function synthetic(overrides: Record<string, any> = {}): SshCodexTransport {
  return new SshCodexTransport({ hostname: "fixture.invalid", port: 22, username: "fixture", knownHostsFile: "/synthetic/known_hosts", authentication: { kind: "agent" }, connectTimeoutMs: 2_000, ...overrides,
    spawnSsh: (args, env) => spawn(process.execPath, [fixture, args.at(-1)!], { stdio: ["pipe", "pipe", "pipe"], env: { ...env, ...overrides.env } }),
  });
}
test("Desktop/HyperNode command uses eight octal sentinel bytes and attach-only proxy", () => {
  const command = buildCodexProxyCommand({ socketPath: "/remote/my socket", codexHome: "/remote/home's" }, Buffer.from([1,2,3,4,5,6,7,8]));
  assert.match(command, /CODEX_REMOTE_PAYLOAD/u);
  assert.match(command, /\\001\\002\\003\\004\\005\\006\\007\\010/u);
  assert.match(command, /codex app-server proxy --sock/u);
  assert.doesNotMatch(command, /pkill|nohup|bootstrap|daemon start/u);
  assert.throws(() => buildCodexProxyCommand({ socketPath: "relative" }, Buffer.alloc(8)), /absolute/u);
  for (const config of [{ codexExecutable: "relative" }, { codexHome: "relative" }, { socketPath: "relative" }]) {
    assert.throws(() => synthetic(config), /absolute/u, "Native execution settings remain validated at their own adapter");
  }
});
test("fragmented banner/sentinel, real HTTP/WebSocket upgrade and RPC roundtrip", async () => {
  const transport = synthetic();
  try {
    await Promise.all([transport.connect(), transport.connect()]);
    const reply = new Promise<any>(resolve => transport.subscribeMessage(frame => resolve(JSON.parse(frame))));
    await transport.send(JSON.stringify({ id: 1, method: "initialize", params: {} }));
    assert.equal((await reply).result.userAgent, "fixture-codex");
    assert.equal(transport.status.state, "open");
  } finally { await transport.close(); }
});
test("password askpass uses private IPC, not argv or inherited env; closes cleanly", async () => {
  const secret = "synthetic-password";
  let requested = false;
  let helper = "";
  const transport = new SshCodexTransport({ hostname: "fixture.invalid", port: 22, username: "fixture", knownHostsFile: "/synthetic/known_hosts", authentication: { kind: "password", resolvePassword: async () => { requested = true; return secret; } },
    spawnSsh: (args, env) => {
      assert.ok(!JSON.stringify(args).includes(secret));
      assert.ok(!JSON.stringify(env).includes(secret));
      helper = env.SSH_ASKPASS!;
      return spawn(process.execPath, [fixture, args.at(-1)!], { stdio: ["pipe", "pipe", "pipe"], env: { ...env, FIXTURE_ASKPASS: "1" } });
    },
  });
  try { await transport.connect(); assert.equal(requested, true); }
  finally { await transport.close(); }
  await assert.rejects(access(helper));
});
test("silent upgrade and explicit close during connect terminate boundedly", async () => {
  const transport = new SshCodexTransport({ hostname: "fixture.invalid", port: 22, username: "fixture", knownHostsFile: "/synthetic/known_hosts", authentication: { kind: "agent" }, connectTimeoutMs: 100,
    spawnSsh: () => spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: ["pipe", "pipe", "pipe"] }),
  });
  const connecting = transport.connect();
  const rejected = assert.rejects(connecting, /cancelled/u);
  await transport.close(); await rejected;
  assert.equal(transport.status.state, "closed");
});
test("SSH trust/authentication failure classes are manual and raw stderr never escapes", async () => {
  for (const [stderr, code] of [["Host key verification failed secret", "SSH_HOST_KEY"], ["Permission denied synthetic-password", "SSH_AUTHENTICATION"], ["codex: command not found", "SSH_CODEX_UNAVAILABLE"]]) {
    const transport = new SshCodexTransport({ hostname: "fixture.invalid", port: 22, username: "fixture", knownHostsFile: "/synthetic/known_hosts", authentication: { kind: "agent" }, connectTimeoutMs: 1_000,
      spawnSsh: () => spawn(process.execPath, ["-e", `process.stderr.write(${JSON.stringify(stderr)});process.exit(255)`], { stdio: ["pipe", "pipe", "pipe"] }),
    });
    try { await assert.rejects(transport.connect()); assert.deepEqual(transport.status.failure, { code, recovery: "manual" }); assert.ok(!transport.status.reason?.includes("secret")); assert.ok(!transport.status.reason?.includes("synthetic-password")); }
    finally { await transport.close(); }
  }
});
test("WebSocket heartbeat detects an SSH process that lives but no longer answers RPC pings", async () => {
  const transport = synthetic({ heartbeatIntervalMs: 10, heartbeatTimeoutMs: 20, env: { FIXTURE_NO_PONG: "1" } });
  try {
    await transport.connect();
    await new Promise<void>(resolve => transport.subscribeStatus(status => { if (status.state === "failed") resolve(); }));
    assert.equal(transport.status.failure?.code, "SSH_RPC_HEARTBEAT");
  } finally { await transport.close(); }
});
test("incompatible RPC upgrade is manual, not an endless retryable SSH timeout", async () => {
  const transport = synthetic({ env: { FIXTURE_BAD_UPGRADE: "1" } });
  try {
    await assert.rejects(transport.connect(), /protocol/u);
    assert.deepEqual(transport.status.failure, { code: "SSH_RPC_PROTOCOL", recovery: "manual" });
  } finally { await transport.close(); }
});
test("private config rejects arbitrary shell, duplicate identity, public permissions and inline secrets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencraft-ssh-config-test-"));
  const path = join(directory, "servers.json");
  const entry = { serverId: "ssh:fixture", displayName: "Fixture", hostname: "fixture.invalid", port: 22, username: "fixture", knownHostsFile: "/fixture/known_hosts", authentication: { kind: "agent" }, workspaceBrowseRoots: ["/remote"] };
  try {
    await writeFile(path, JSON.stringify([entry]), { mode: 0o600 });
    const [binding] = await readSshCodexServerBindings(path);
    assert.deepEqual(parseSshServerDescriptors([binding.descriptor]), [binding.descriptor]);
    assert.ok(!JSON.stringify(binding.descriptor).includes("known_hosts"));
    for (const value of [[{ ...entry, command: "arbitrary" }], [{ ...entry, password: "secret" }], [entry, entry], [{ ...entry, hostname: "-oProxyCommand=bad" }]]) {
      await writeFile(path, JSON.stringify(value)); await assert.rejects(readSshCodexServerBindings(path));
    }
    await writeFile(path, '{"password": synthetic-secret}');
    await assert.rejects(readSshCodexServerBindings(path), error => error instanceof Error
      && error.message === "Invalid SSH Server configuration");
    await chmod(path, 0o644); await assert.rejects(readSshCodexServerBindings(path), /private/u);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("real OpenSSH exec to an isolated loopback sshd carries WebSocket RPC and enforces pinned trust", async context => {
  if (process.getuid?.() !== 0) { context.skip("Isolated sshd smoke requires root on this Linux runner"); return; }
  try { await access("/usr/sbin/sshd"); await access("/run/sshd"); } catch { context.skip("No local sshd runtime available"); return; }
  const directory = await mkdtemp(join(tmpdir(), "opencraft-ssh-real-test-"));
  const socket = createServer(); await new Promise<void>(resolve => socket.listen(0, "127.0.0.1", resolve));
  const address = socket.address(); assert.ok(address && typeof address !== "string");
  const port = address.port; await new Promise<void>(resolve => socket.close(() => resolve()));
  let sshd: ReturnType<typeof spawn> | undefined;
  const transports: SshCodexTransport[] = [];
  try {
    const hostKey = join(directory, "host-key"); const clientKey = join(directory, "client-key");
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", hostKey]);
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", clientKey]);
    const authorized = join(directory, "authorized_keys"); await writeFile(authorized, await readFile(clientKey + ".pub"), { mode: 0o600 });
    const hostPublic = (await readFile(hostKey + ".pub", "utf8")).trim().split(" ").slice(0, 2).join(" ");
    const known = join(directory, "known_hosts"); await writeFile(known, `[127.0.0.1]:${port} ${hostPublic}\n`);
    const config = join(directory, "sshd_config");
    await writeFile(config, `Port ${port}\nListenAddress 127.0.0.1\nHostKey ${hostKey}\nPidFile ${directory}/pid\nAuthorizedKeysFile ${authorized}\nStrictModes yes\nPasswordAuthentication no\nPermitRootLogin yes\nUsePAM no\nForceCommand ${process.execPath} ${fixture}\nLogLevel ERROR\n`, { mode: 0o600 });
    sshd = spawn("/usr/sbin/sshd", ["-D", "-e", "-f", config], { stdio: ["ignore", "ignore", "pipe"] });
    await new Promise(resolve => setTimeout(resolve, 100));
    const good = new SshCodexTransport({ hostname: "127.0.0.1", port, username: "root", knownHostsFile: known, authentication: { kind: "key", identityFile: clientKey } });
    transports.push(good); await good.connect();
    const reply = new Promise<any>(resolve => good.subscribeMessage(frame => resolve(JSON.parse(frame))));
    await good.send(JSON.stringify({ id: 9, method: "initialize", params: {} })); assert.equal((await reply).id, 9);
    const emptyKnown = join(directory, "untrusted"); await writeFile(emptyKnown, "");
    const bad = new SshCodexTransport({ hostname: "127.0.0.1", port, username: "root", knownHostsFile: emptyKnown, authentication: { kind: "key", identityFile: clientKey } });
    transports.push(bad); await assert.rejects(bad.connect()); assert.equal(bad.status.failure?.code, "SSH_HOST_KEY");
  } finally {
    await Promise.all(transports.map(transport => transport.close()));
    if (sshd && sshd.exitCode === null) { sshd.kill("SIGTERM"); await new Promise(resolve => sshd!.once("close", resolve)); }
    await rm(directory, { recursive: true, force: true });
  }
});


test("oversized RPC stops automatic retries and emits bounded diagnostics without private data", async () => {
  const diagnostics: unknown[] = [];
  const transport = synthetic({ maxFrameBytes: 128, env: { FIXTURE_OVERSIZED_RPC: "1" },
    reportFailure: (event: unknown) => { diagnostics.push(event); throw new Error("diagnostic sink failure"); } });
  try {
    await transport.connect();
    if (transport.status.state !== "failed") await new Promise<void>(resolve => transport.subscribeStatus(status => { if (status.state === "failed") resolve(); }));
    assert.deepEqual(transport.status.failure, { code: "SSH_RPC_FRAME_LIMIT", recovery: "manual" });
    assert.equal(diagnostics.length, 1);
    const event = diagnostics[0] as Record<string, unknown>;
    assert.equal(event.websocketErrorCode, "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH");
    assert.deepEqual(Object.keys(event).sort(), ["ageMs", "code", "recovery", "sshExitCode", "websocketCloseCode", "websocketErrorCode"]);
    assert.equal(JSON.stringify(event).includes("fixture.invalid"), false);
  } finally { await transport.close(); }
});


test("large Codex history responses exceed 16MiB without widening outbound mutations", async () => {
  const transport = synthetic({ env: { FIXTURE_LARGE_HISTORY: "1" } });
  const reply = new Promise<string>(resolve => transport.subscribeMessage(resolve));
  try {
    await transport.connect();
    const frame = await reply;
    assert.equal(JSON.parse(frame).data.length, 17 * 1024 * 1024);
    assert.equal(transport.status.state, "open");
    await assert.rejects(transport.send("x".repeat(17 * 1024 * 1024)), /limit exceeded/u);
    const roundtrip = new Promise<any>(resolve => transport.subscribeMessage(frame => resolve(JSON.parse(frame))));
    await transport.send(JSON.stringify({ id: 1, method: "initialize", params: {} }));
    assert.equal((await roundtrip).result.userAgent, "fixture-codex");
  } finally { await transport.close(); }
});
