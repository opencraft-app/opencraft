import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createServer, connect } from "node:net";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { userInfo } from "node:os";
import { once } from "node:events";

/** Private, real SSH protocol/authentication fixture. No system installation,
 * account/key changes or public listener; Codex and browser remain separate. */
export async function createLoopbackSshFixture(root: string) {
  const executable = process.env.OPENCRAFT_TEST_SSHD;
  assert(executable?.startsWith("/"), "OPENCRAFT_TEST_SSHD must name an absolute test sshd executable");
  const directory = join(root, "ssh");
  await mkdir(directory, { mode: 0o700 });
  const host = join(directory, "host-key"),
    client = join(directory, "client-key");
  for (const path of [host, client])
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", path], { stdio: "pipe" });
  const authorized = join(directory, "authorized_keys"),
    known = join(directory, "known_hosts");
  await writeFile(authorized, await readFile(client + ".pub"), { mode: 0o600 });
  const reserve = createServer();
  reserve.listen(0, "127.0.0.1");
  await once(reserve, "listening");
  const port = (reserve.address() as { port: number }).port;
  await new Promise<void>((resolve) => reserve.close(() => resolve()));
  const username = userInfo().username,
    config = join(directory, "sshd_config");
  assert(/^[a-zA-Z0-9._-]+$/u.test(username));
  const quote = (value: string) => {
    assert(!/["\r\n]/u.test(value));
    return '"' + value + '"';
  };
  await writeFile(known, `[127.0.0.1]:${port} ${(await readFile(host + ".pub", "utf8")).trim()}\n`, { mode: 0o600 });
  await writeFile(
    config,
    [
      `Port ${port}`,
      "ListenAddress 127.0.0.1",
      `HostKey ${quote(host)}`,
      `PidFile ${quote(join(directory, "sshd.pid"))}`,
      `AuthorizedKeysFile ${quote(authorized)}`,
      `AllowUsers ${username}`,
      "PubkeyAuthentication yes",
      "PasswordAuthentication no",
      "KbdInteractiveAuthentication no",
      "UsePAM no",
      "StrictModes yes",
      "AllowTcpForwarding no",
      "AllowAgentForwarding no",
      "X11Forwarding no",
      "PermitTunnel no",
      "PermitUserEnvironment no",
      "LogLevel ERROR",
    ].join("\n"),
    { mode: 0o600 },
  );
  const env = { ...process.env };
  if (process.env.OPENCRAFT_TEST_SSHD_LIBRARY_PATH) env.LD_LIBRARY_PATH = process.env.OPENCRAFT_TEST_SSHD_LIBRARY_PATH;
  const server = spawn(executable, ["-D", "-e", "-f", config], { env, stdio: ["ignore", "pipe", "pipe"] });
  let spawnError: Error | undefined;
  server.once("error", (error) => {
    spawnError = error;
  });
  server.stdout.resume();
  let failure = "";
  server.stderr.on("data", (bytes) => {
    failure = (failure + bytes).slice(-2000);
  });
  const close = async () => {
    if (server.pid && server.exitCode === null && server.signalCode === null) {
      const closed = once(server, "close");
      server.kill("SIGTERM");
      await closed;
    }
  };
  try {
    const deadline = Date.now() + 5000;
    for (;;) {
      if (spawnError) throw spawnError;
      assert.equal(server.exitCode, null, "Isolated sshd exited: " + failure);
      const ready = await new Promise<boolean>((resolve) => {
        const socket = connect(port, "127.0.0.1");
        socket.once("connect", () => {
          socket.destroy();
          resolve(true);
        });
        socket.once("error", () => resolve(false));
      });
      if (ready) break;
      assert(Date.now() < deadline, "Isolated sshd not ready: " + failure);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const args = [
      "-F",
      "/dev/null",
      "-p",
      String(port),
      "-l",
      username,
      "-i",
      client,
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      `UserKnownHostsFile=${known}`,
      "-o",
      "GlobalKnownHostsFile=/dev/null",
      "-o",
      "IdentitiesOnly=yes",
      "127.0.0.1",
      "printf LOOPBACK_SSH_OK",
    ];
    assert.equal(execFileSync("ssh", args, { encoding: "utf8", timeout: 5000 }).trim(), "LOOPBACK_SSH_OK");
    // Unknown host keys must not be accepted by a real client.
    const wrong = join(directory, "unknown_hosts");
    await writeFile(wrong, "", { mode: 0o600 });
    const rejected = [...args];
    rejected[rejected.indexOf(`UserKnownHostsFile=${known}`)] = `UserKnownHostsFile=${wrong}`;
    assert.throws(
      () => execFileSync("ssh", rejected, { stdio: "pipe", timeout: 5000 }),
      (error) => {
        const result = error as { status: number; stderr: Buffer };
        assert.equal(result.status, 255);
        assert.match(String(result.stderr), /Host key verification failed/u);
        return true;
      },
    );
    return {
      connection: {
        hostname: "127.0.0.1",
        port,
        username,
        knownHostsFile: known,
        authentication: { kind: "key" as const, identityFile: client },
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
