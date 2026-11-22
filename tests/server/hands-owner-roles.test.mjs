import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HANDS_OWNER_PROCESSES, startContainerHands } from "../../scripts/container-deployment/hands-application.mjs";

function fakeChild() {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = (signal) => {
    child.signalCode = signal;
    queueMicrotask(() => {
      child.emit("exit", null, signal);
      child.emit("close", null, signal);
    });
    return true;
  };
  child.exit = (code) => {
    child.exitCode = code;
    child.emit("exit", code, null);
    child.emit("close", code, null);
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
  const data = await mkdtemp(join(tmpdir(), "opencraft-hands-roles-"));
  const previous = { data: process.env.OPENCRAFT_BROWSER_DATA_DIR, exitCode: process.exitCode };
  const signals = { SIGINT: process.listeners("SIGINT"), SIGTERM: process.listeners("SIGTERM") };
  t.after(async () => {
    if (previous.data === undefined) delete process.env.OPENCRAFT_BROWSER_DATA_DIR;
    else process.env.OPENCRAFT_BROWSER_DATA_DIR = previous.data;
    process.exitCode = previous.exitCode;
    for (const [name, before] of Object.entries(signals))
      for (const listener of process.listeners(name))
        if (!before.includes(listener)) process.removeListener(name, listener);
    await rm(data, { recursive: true, force: true });
  });
  process.env.OPENCRAFT_BROWSER_DATA_DIR = data;
  const calls = [],
    children = [];
  const spawnOwner = (command, args, options, owner) => {
    const child = fakeChild();
    calls.push({ command, args, options, owner });
    children.push(child);
    // Stop startup once every owner has been spawned instead of waiting for sockets.
    if (children.length === HANDS_OWNER_PROCESSES.length) setImmediate(() => children[0].exit(0));
    return child;
  };
  await startContainerHands({ spawnOwner });
  assert.deepEqual(
    calls.map((call) => call.owner),
    [{ role: "browser" }, { role: "execution" }, { role: "terminal" }, { role: "files" }],
  );
  assert.ok(calls[0].args[0].endsWith(join("runtime", "browser", "owner.cjs")));
  assert.deepEqual(calls[2].args.slice(1), ["--hands-terminal-owner"]);
  assert.ok(calls.every((call) => call.options.shell === false));
  assert.equal(process.exitCode, 1);
});
