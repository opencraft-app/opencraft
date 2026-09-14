import assert from "node:assert/strict";
import test from "node:test";

import {
  DEMO_LOCAL_ENVIRONMENT_PATH,
  DEMO_LOCAL_ENVIRONMENT_TOML,
  LocalEnvironmentCatalog,
  LocalEnvironmentService,
} from "../src/services/local-environment.js";

test("local environment catalog projects the demo action as a virtual directory and file", () => {
  const catalog = new LocalEnvironmentCatalog();
  catalog.registerDefault(DEMO_LOCAL_ENVIRONMENT_PATH, DEMO_LOCAL_ENVIRONMENT_TOML);

  assert.equal(catalog.metadata("/localhost/polaris/.codex/environments").isDirectory, true);
  assert.deepEqual(catalog.readDirectory("/localhost/polaris/.codex/environments"), [{
    fileName: "environment.toml",
    isDirectory: false,
    isFile: true,
  }]);
  assert.equal(
    Buffer.from(catalog.readFile(DEMO_LOCAL_ENVIRONMENT_PATH)).toString("utf8"),
    DEMO_LOCAL_ENVIRONMENT_TOML,
  );
  assert.match(DEMO_LOCAL_ENVIRONMENT_TOML, /command = "echo aaa"/);
});

test("per-user writes override the default without mutating another user's environment", () => {
  const catalog = new LocalEnvironmentCatalog();
  catalog.registerDefault(DEMO_LOCAL_ENVIRONMENT_PATH, DEMO_LOCAL_ENVIRONMENT_TOML);
  const alice = { id: "user:alice" };
  const bob = { id: "user:bob" };
  const replacement = DEMO_LOCAL_ENVIRONMENT_TOML.replace("echo aaa", "echo alice");

  catalog.write(DEMO_LOCAL_ENVIRONMENT_PATH, Buffer.from(replacement), alice);

  assert.equal(Buffer.from(catalog.readFile(DEMO_LOCAL_ENVIRONMENT_PATH, alice)).toString("utf8"), replacement);
  assert.equal(Buffer.from(catalog.readFile(DEMO_LOCAL_ENVIRONMENT_PATH, bob)).toString("utf8"), DEMO_LOCAL_ENVIRONMENT_TOML);
});

test("normalization keeps local environment paths inside their virtual workspace", () => {
  const catalog = new LocalEnvironmentCatalog();
  assert.equal(
    catalog.normalize("/localhost/polaris/./src/../.codex/environments/environment.toml"),
    DEMO_LOCAL_ENVIRONMENT_PATH,
  );
  assert.throws(() => catalog.normalize("localhost/polaris"), /must be absolute/);
});

test("virtual cat follows the official streaming process lifecycle", () => {
  const service = Object.create(LocalEnvironmentService.prototype);
  service.catalog = new LocalEnvironmentCatalog();
  service.catalog.registerDefault(DEMO_LOCAL_ENVIRONMENT_PATH, DEMO_LOCAL_ENVIRONMENT_TOML);
  const sent = [];
  const audited = [];
  service.ctx = {
    appServer: { audit: (...args) => audited.push(args) },
    userDirectory: { find: () => null },
  };
  const connection = {
    identity: null,
    socket: { send: (message) => sent.push(message) },
  };

  assert.equal(service.intercept({
    id: "spawn-1",
    method: "process/spawn",
    params: {
      command: ["cat", DEMO_LOCAL_ENVIRONMENT_PATH],
      cwd: "/",
      processHandle: "environment-read-1",
      streamStdoutStderr: true,
    },
  }, connection), true);

  assert.deepEqual(sent[0], { id: "spawn-1", result: {} });
  assert.equal(sent[1].method, "process/outputDelta");
  assert.equal(Buffer.from(sent[1].params.deltaBase64, "base64").toString("utf8"), DEMO_LOCAL_ENVIRONMENT_TOML);
  assert.deepEqual(sent[2], {
    method: "process/exited",
    params: {
      processHandle: "environment-read-1",
      exitCode: 0,
      stdout: "",
      stdoutCapReached: false,
      stderr: "",
      stderrCapReached: false,
    },
  });
  assert.equal(audited.length, 1);
});
