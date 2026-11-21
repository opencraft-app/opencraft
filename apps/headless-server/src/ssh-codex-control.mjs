import { access, constants } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
var run = promisify(execFile);
function createSshCodexControl(appHostServer, executable) {
  return async (action, signal) => {
    signal.throwIfAborted();
    if (action === "locate") {
      await access(executable, constants.X_OK);
      signal.throwIfAborted();
      return "";
    }
    if (action === "version") {
      const { stdout } = await run(executable, ["--version"], { signal, timeout: 5e3, maxBuffer: 4096 });
      if (!/^codex-cli [0-9][^\r\n]*\r?\n?$/u.test(stdout)) throw new Error("Invalid installed Codex version");
      return stdout;
    }
    if (action !== "ensure") throw new Error("Unsupported SSH control action");
    await appHostServer.ensureHostConnected("local-codex", () => signal.throwIfAborted());
    signal.throwIfAborted();
    return "";
  };
}
export {
  createSshCodexControl
};
