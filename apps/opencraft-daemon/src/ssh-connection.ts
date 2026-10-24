import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

export type SshAuthentication =
  | { readonly kind: "key"; readonly identityFile: string }
  | { readonly kind: "agent" }
  | { readonly kind: "password"; readonly resolvePassword: () => Promise<string> };

/** Backend-owned SSH trust and credentials, independent of the remote service. */
export interface SshConnectionOptions {
  readonly hostname: string;
  readonly port: number;
  readonly username: string;
  readonly knownHostsFile: string;
  readonly authentication: SshAuthentication;
  readonly connectTimeoutMs?: number;
}

export function validateSshConnection(options: SshConnectionOptions): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9.:-]*$/u.test(options.hostname) || !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/u.test(options.username)
    || !Number.isInteger(options.port) || options.port < 1 || options.port > 65535 || !isAbsolute(options.knownHostsFile)) throw new Error("Invalid SSH endpoint or trust configuration");
  if (options.authentication.kind === "key" && !isAbsolute(options.authentication.identityFile)) throw new Error("SSH identity file must be absolute");
}

export class SshConnectionError extends Error {
  constructor(readonly code: string, readonly retryable: boolean, message: string) { super(message); }
}

export function quoteSshShellArgument(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }

/** Password is delivered through a private local socket, never argv/env/stdin RPC. */
export async function createSshPasswordAgent(resolvePassword: () => Promise<string>): Promise<{ env: NodeJS.ProcessEnv; close(): Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), "opencraft-ssh-auth-"));
  await chmod(directory, 0o700);
  const socketPath = join(directory, "askpass.sock");
  const sockets = new Set<import("node:net").Socket>();
  let used = false;
  let closed = false;
  let closeOperation: Promise<void> | null = null;
  const server = createServer(socket => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.setTimeout(5_000, () => socket.destroy());
    if (used || closed) { socket.end(); return; }
    used = true;
    void resolvePassword().then(password => {
      if (!closed && !socket.destroyed && !/[\r\n\0]/u.test(password)) socket.end(password + "\n");
      else socket.destroy();
    }, () => socket.destroy());
  });
  const close = (): Promise<void> => {
    if (closeOperation) return closeOperation;
    closed = true;
    closeOperation = (async () => {
      for (const socket of sockets) socket.destroy();
      if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    })();
    return closeOperation;
  };
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
    await chmod(socketPath, 0o600);
    const helper = join(directory, "askpass.cjs");
    await writeFile(helper, `const net = require('node:net'); const s = net.connect(${JSON.stringify(socketPath)}); s.setTimeout(5000, () => process.exit(1)); s.on('data', b => process.stdout.write(b)); s.on('error', () => process.exit(1)); s.on('end', () => process.exit(0));`, { mode: 0o600 });
    const executable = join(directory, "askpass");
    await writeFile(executable, `#!/bin/sh\nexec ${quoteSshShellArgument(process.execPath)} ${quoteSshShellArgument(helper)}\n`, { mode: 0o700 });
    return { env: { SSH_ASKPASS: executable, SSH_ASKPASS_REQUIRE: "force", DISPLAY: "opencraft-askpass" }, close };
  } catch (error) { await close(); throw error; }
}

export function classifySshFailure(stderr: string): SshConnectionError {
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed|No .* host key is known/u.test(stderr)) {
    return new SshConnectionError("SSH_HOST_KEY", false, "SSH host identity must be verified");
  }
  if (/Permission denied|Authentication failed|Too many authentication failures/u.test(stderr)) {
    return new SshConnectionError("SSH_AUTHENTICATION", false, "SSH authentication failed");
  }
  return new SshConnectionError("SSH_LINK_LOST", true, "Remote connection was interrupted");
}
