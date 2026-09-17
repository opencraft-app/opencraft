import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  electronAppEnvironment,
  electronLaunchSpec,
  startElectron,
} from "../scripts/start-electron.mjs";

test("Electron app launch removes inherited Node mode without mutating the source environment", () => {
  const source = { ELECTRON_RUN_AS_NODE: "1", OPENCRAFT_TEST_VALUE: "kept" };
  const environment = electronAppEnvironment(source);

  assert.equal(environment.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(environment.OPENCRAFT_TEST_VALUE, "kept");
  assert.equal(source.ELECTRON_RUN_AS_NODE, "1");
});

test("Electron launch resolves the real binary, application root and caller arguments", () => {
  const launch = electronLaunchSpec(["--user-data-dir=/tmp/profile", "--remote-debugging-port=9472"], {
    ELECTRON_RUN_AS_NODE: "1",
  });

  assert.match(launch.executable, /electron(?:\.app[\\/]Contents[\\/]MacOS[\\/]Electron|\.exe)?$/iu);
  assert.match(launch.args[0], /apps[\\/]workbench-electron$/u);
  assert.deepEqual(launch.args.slice(1), [
    "--user-data-dir=/tmp/profile",
    "--remote-debugging-port=9472",
  ]);
  assert.equal(launch.options.env.ELECTRON_RUN_AS_NODE, undefined);
});

test("startElectron passes the sanitized launch contract to the child process", async () => {
  const child = new EventEmitter();
  let observed;
  const started = startElectron(["--diagnostic"], {
    environment: { ELECTRON_RUN_AS_NODE: "1", PRESERVED: "yes" },
    spawnImpl(executable, args, options) {
      observed = { executable, args, options };
      queueMicrotask(() => child.emit("exit", 0, null));
      return child;
    },
  });

  await started;
  assert.equal(observed.options.env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(observed.options.env.PRESERVED, "yes");
  assert.deepEqual(observed.args.slice(1), ["--diagnostic"]);
});

test("the workbench start script uses the sanitized Electron launcher", async () => {
  const manifest = JSON.parse(await readFile(
    new URL("../apps/workbench-electron/package.json", import.meta.url),
    "utf8",
  ));
  assert.equal(
    manifest.scripts.start,
    "npm run build:host && node ../../scripts/start-electron.mjs",
  );
});
