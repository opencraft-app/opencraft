import assert from "node:assert/strict";
import test from "node:test";

import { buildRuntimeProcessEnv, LOGIN_SHELL_ENV_MARKER } from "./velad-runtime-shell-env";

test("runtime process env imports login shell env and restores Electron flags", () => {
  const baseEnv = {
    PATH: "/base/bin",
    SHELL: "/bin/zsh",
    ELECTRON_RUN_AS_NODE: "original",
    VELA_DESKTOP_VELAD_PATH: "/repo/target/debug/velad",
  };
  const shellEnv = {
    PATH: "/shell/bin:/usr/bin",
    ELECTRON_RUN_AS_NODE: "1",
    ELECTRON_NO_ATTACH_CONSOLE: "1",
    VELA_DESKTOP_VELAD_PATH: "",
    XDG_RUNTIME_DIR: "/tmp/runtime",
    CUSTOM_FROM_SHELL: "yes",
  };

  const result = buildRuntimeProcessEnv({
    baseEnv,
    execPath: "/Applications/Vela.app/Contents/MacOS/Vela",
    platform: "darwin",
    spawnSyncImpl: ((command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
      assert.equal(command, "/bin/zsh");
      assert.deepEqual(args.slice(0, 3), ["-i", "-l", "-c"]);
      assert.equal(options.env.ELECTRON_RUN_AS_NODE, "1");
      assert.equal(options.env.ELECTRON_NO_ATTACH_CONSOLE, "1");
      return {
        status: 0,
        stdout: `shell noise\n${LOGIN_SHELL_ENV_MARKER}${JSON.stringify(shellEnv)}${LOGIN_SHELL_ENV_MARKER}\n`,
        stderr: "",
      };
    }) as never,
  });

  assert.equal(result.loginShellEnvApplied, true);
  assert.equal(result.env.PATH, "/shell/bin:/usr/bin");
  assert.equal(result.env.CUSTOM_FROM_SHELL, "yes");
  assert.equal(result.env.ELECTRON_RUN_AS_NODE, "original");
  assert.equal(result.env.ELECTRON_NO_ATTACH_CONSOLE, undefined);
  assert.equal(result.env.XDG_RUNTIME_DIR, undefined);
  assert.equal(result.env.VELA_DESKTOP_VELAD_PATH, "/repo/target/debug/velad");
});

test("runtime process env uses user default shell when SHELL is missing", () => {
  const result = buildRuntimeProcessEnv({
    baseEnv: {
      PATH: "/base/bin",
    },
    execPath: "/Applications/Vela.app/Contents/MacOS/Vela",
    platform: "darwin",
    userInfoImpl: (() => ({ shell: "/bin/zsh" })) as never,
    spawnSyncImpl: ((command: string) => {
      assert.equal(command, "/bin/zsh");
      return {
        status: 0,
        stdout: `${LOGIN_SHELL_ENV_MARKER}${JSON.stringify({ PATH: "/default-shell/bin" })}${LOGIN_SHELL_ENV_MARKER}`,
        stderr: "",
      };
    }) as never,
  });

  assert.equal(result.loginShellEnvApplied, true);
  assert.equal(result.env.PATH, "/default-shell/bin");
});

test("runtime process env falls back to process env when shell env is unavailable", () => {
  const result = buildRuntimeProcessEnv({
    baseEnv: {
      PATH: "/base/bin",
      SHELL: "/bin/zsh",
    },
    platform: "win32",
  });

  assert.equal(result.loginShellEnvApplied, false);
  assert.equal(result.env.PATH, "/base/bin");
  assert.match(result.loginShellEnvError ?? "", /Windows/);
});
