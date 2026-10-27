import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createSshPasswordAgent, classifySshFailure, SshConnectionError, validateSshConnection, type SshConnectionOptions } from "./ssh-connection.js";

/** SFTP has its own quoting rules, distinct from a shell or JSON. */
export function quoteSftpPath(path: string): string {
  if (!path || /[\r\n\0]/u.test(path)) throw new Error("Invalid SFTP path");
  return `"${path.replace(/[\\"]/gu, "\\$&")}"`;
}

export interface SshFileTransferOptions {
  readonly connection: SshConnectionOptions;
  readonly timeoutMs?: number;
  readonly spawnSftp?: (args: readonly string[], env: NodeJS.ProcessEnv) => ChildProcessWithoutNullStreams;
}

/** Reuse installation-owned credentials/trust; no browser-supplied commands. */
export class SshFileTransfer {
  private readonly lifetime = new AbortController();
  private readonly operations = new Set<Promise<void>>();
  constructor(private readonly options: SshFileTransferOptions) {
    validateSshConnection(options.connection);
  }

  upload(sourcePath: string, targetPath: string, timeoutMs?: number): Promise<void> {
    return this.batch([`put ${quoteSftpPath(sourcePath)} ${quoteSftpPath(targetPath)}`, `chmod 600 ${quoteSftpPath(targetPath)}`], timeoutMs);
  }
  download(sourcePath: string, targetPath: string, timeoutMs?: number): Promise<void> {
    return this.batch([`get ${quoteSftpPath(sourcePath)} ${quoteSftpPath(targetPath)}`], timeoutMs);
  }
  commit(partPath: string, targetPath: string): Promise<void> {
    return this.batch([`rename ${quoteSftpPath(partPath)} ${quoteSftpPath(targetPath)}`, `chmod 600 ${quoteSftpPath(targetPath)}`]);
  }
  protectDirectory(path: string): Promise<void> { return this.batch([`chmod 700 ${quoteSftpPath(path)}`]); }

  private batch(commands: readonly string[], timeoutMs?: number): Promise<void> {
    if (this.lifetime.signal.aborted) return Promise.reject(new Error("SSH file transfer is closed"));
    const operation = this.run(commands, timeoutMs).finally(() => this.operations.delete(operation));
    this.operations.add(operation);
    return operation;
  }

  private async run(commands: readonly string[], timeoutMs?: number): Promise<void> {
    const { connection } = this.options;
    let auth: Awaited<ReturnType<typeof createSshPasswordAgent>> | undefined;
    try {
      if (connection.authentication.kind === "password") auth = await createSshPasswordAgent(connection.authentication.resolvePassword);
      if (this.lifetime.signal.aborted) throw new Error("SSH file transfer is closed");
      const args = ["-b", "-", "-F", "/dev/null", "-P", String(connection.port),
        "-o", `User=${connection.username}`, "-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${connection.knownHostsFile}`,
        "-o", "GlobalKnownHostsFile=/dev/null", "-o", "ForwardAgent=no", "-o", "ClearAllForwardings=yes", "-o", "PermitLocalCommand=no",
        "-o", `ConnectTimeout=${Math.max(1, Math.ceil((connection.connectTimeoutMs ?? 15000) / 1000))}`,
        "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=2"];
      // OpenSSH sftp -b prepends BatchMode=yes to ssh, overriding a normal -o.
      // A private fixed wrapper places the password override first while retaining
      // batch exit status, all trust arguments, and secret-free askpass IPC.
      if (auth) {
        const wrapper = join(dirname(auth.env.SSH_ASKPASS!), "sftp-ssh");
        await writeFile(wrapper, '#!/bin/sh\nexec ssh -o BatchMode=no "$@"\n', { flag: "wx", mode: 0o700 });
        args.push("-S", wrapper, "-o", "BatchMode=no", "-o", "PreferredAuthentications=password", "-o", "NumberOfPasswordPrompts=1");
      }
      else {
        args.push("-o", "BatchMode=yes", "-o", "PreferredAuthentications=publickey");
        if (connection.authentication.kind === "key") args.push("-o", "IdentitiesOnly=yes", "-i", connection.authentication.identityFile);
      }
      args.push("--", connection.hostname);
      const env = { ...process.env, ...auth?.env };
      if (!auth) { delete env.SSH_ASKPASS; delete env.SSH_ASKPASS_REQUIRE; }
      delete env.ELECTRON_RUN_AS_NODE;
      const child = this.options.spawnSftp?.(args, env) ?? spawn("sftp", args, { stdio: ["pipe", "pipe", "pipe"], env });
      await new Promise<void>((resolve, reject) => {
        let stderr = "", settled = false;
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          clearTimeout(killTimer);
          this.lifetime.signal.removeEventListener("abort", abort);
          error ? reject(error) : resolve();
        };
        let killTimer: ReturnType<typeof setTimeout> | undefined;
        const stop = (error: Error) => {
          if (settled || killTimer !== undefined) return;
          clearTimeout(timer);
          child.kill("SIGTERM");
          killTimer = setTimeout(() => { child.kill("SIGKILL"); finish(error); }, 2000);
          child.once("close", () => finish(error));
        };
        const abort = () => stop(new Error("SSH file transfer was cancelled"));
        const timer = setTimeout(() => stop(new Error("SSH file transfer timed out; retry the same attachment")), timeoutMs ?? this.options.timeoutMs ?? 120000);
        child.stdout.resume();
        child.stderr.on("data", data => { stderr = (stderr + String(data)).slice(-4096); });
        child.once("error", () => finish(new Error("SFTP executable is unavailable")));
        child.stdin.on("error", () => undefined); // Close/exit determines operation outcome.
        child.once("close", code => {
          if (killTimer) return; // Cancellation/timeout has a specific outcome.
          if (code === 0) { finish(); return; }
          const classified = classifySshFailure(stderr);
          finish(classified.code === "SSH_LINK_LOST"
            ? new SshConnectionError("SSH_FILE_TRANSFER_FAILED", true, "Remote file transfer failed; retry the same attachment")
            : classified);
        });
        this.lifetime.signal.addEventListener("abort", abort, { once: true });
        if (this.lifetime.signal.aborted) abort();
        else child.stdin.end(commands.join("\n") + "\n");
      });
    } finally { await auth?.close(); }
  }

  async close(): Promise<void> {
    this.lifetime.abort();
    await Promise.allSettled([...this.operations]);
  }
}
