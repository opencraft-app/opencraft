import { spawn } from "node:child_process";
import { SshFileTransfer } from "../../apps/opencraft-daemon/src/ssh-file-transfer.js";
/** Only the SFTP server boundary is synthetic; the real batch runner is used. */
export function fixtureFiles(): SshFileTransfer {
  return new SshFileTransfer({ connection: { hostname: "fixture.invalid", port: 22, username: "fixture", knownHostsFile: "/synthetic/known_hosts", authentication: { kind: "agent" } },
    spawnSftp: (_args, env) => spawn(process.execPath, [new URL("./fake-sftp.mjs", import.meta.url).pathname], { stdio: ["pipe", "pipe", "pipe"], env }),
  });
}
