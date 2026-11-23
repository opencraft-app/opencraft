import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HANDS_OWNER_PROCESSES, startContainerHands } from "../../scripts/container-deployment/hands-application.mjs";
import { deploymentPaths } from "../../scripts/container-deployment/paths.mjs";

// The Hands workspace agent waits for each owner's socket; a fake owner listens on it.
function fakeOwner(path) {
  const child = new EventEmitter();
  const server = createServer((socket) => socket.end());
  server.listen(path);
  child.exitCode = null;
  child.signalCode = null;
  const ended = (code, signal) => {
    server.close();
    child.emit("exit", code, signal);
    child.emit("close", code, signal);
  };
  child.kill = (signal) => {
    child.signalCode = signal;
    queueMicrotask(() => ended(null, signal));
    return true;
  };
  child.exit = (code) => {
    child.exitCode = code;
    ended(code, null);
  };
  return child;
}

test("Hands owner processes have one stable role each", () => {
  assert.deepEqual(
    HANDS_OWNER_PROCESSES.map((owner) => owner.role),
    ["browser", "execution", "terminal", "files"],
  );
  assert.ok(Object.isFrozen(HANDS_OWNER_PROCESSES) && HANDS_OWNER_PROCESSES.every(Object.isFrozen));
});

test("the spawn hook receives each owner role so policy does not depend on entry paths", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "opencraft-hands-roles-"));
  const environment = {
    OPENCRAFT_DATA_DIR: join(directory, "state"),
    OPENCRAFT_WORKSPACE_DIR: join(directory, "work"),
    OPENCRAFT_EXECUTION_DIR: join(directory, "state", "execution"),
    OPENCRAFT_BROWSER_DATA_DIR: join(directory, "state", "execution", "browser"),
    OPENCRAFT_HANDS_EXECUTION_SOCKET: join(directory, "state", "execution", "exec-owner.sock"),
    OPENCRAFT_AGENT_RUN_DIR: join(directory, "run"),
  };
  const previous = { environment: {}, exitCode: process.exitCode };
  for (const key of Object.keys(environment)) previous.environment[key] = process.env[key];
  const signals = { SIGINT: process.listeners("SIGINT"), SIGTERM: process.listeners("SIGTERM") };
  t.after(async () => {
    for (const [key, value] of Object.entries(previous.environment))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    process.exitCode = previous.exitCode;
    for (const [name, before] of Object.entries(signals))
      for (const listener of process.listeners(name))
        if (!before.includes(listener)) process.removeListener(name, listener);
    await rm(directory, { recursive: true, force: true });
  });
  Object.assign(process.env, environment);
  const paths = deploymentPaths(process.env);
  await mkdir(paths.executionDirectory, { recursive: true, mode: 0o700 });
  const sockets = {
    browser: join(environment.OPENCRAFT_BROWSER_DATA_DIR, "owner.sock"),
    execution: environment.OPENCRAFT_HANDS_EXECUTION_SOCKET,
    terminal: paths.terminalEndpoint,
    files: paths.fileSystemEndpoint,
  };
  const calls = [],
    children = [];
  const spawnOwner = (command, args, options, owner) => {
    const child = fakeOwner(sockets[owner.role]);
    calls.push({ command, args, options, owner });
    children.push(child);
    // Stop the agent once every owner has been spawned.
    if (children.length === HANDS_OWNER_PROCESSES.length) setImmediate(() => children[0].exit(0));
    return child;
  };
  const agent = await startContainerHands({ spawnOwner });
  assert.equal(await agent.exited, 1);
  // The agent starts the Hands role's owners, then the browser role.
  assert.deepEqual(
    calls.map((call) => call.owner),
    [{ role: "execution" }, { role: "terminal" }, { role: "files" }, { role: "browser" }],
  );
  assert.ok(calls[3].args[0].endsWith(join("runtime", "browser", "owner.cjs")));
  assert.deepEqual(calls[1].args.slice(1), ["--hands-terminal-owner"]);
  assert.ok(calls.every((call) => call.options.shell === false));
  assert.equal(process.exitCode, 1);
});
