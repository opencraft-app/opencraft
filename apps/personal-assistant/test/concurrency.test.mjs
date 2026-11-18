import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { initProfile, loadProfile } from "../src/adapters/local/profile.mjs";
import { provisionBotProfile } from "../src/adapters/local/bot-profile.mjs";
import { createLocalDomain } from "../src/runtime/create-local-domain.mjs";
import { WorkCoordinator } from "../src/runtime/work-coordinator.mjs";
import { profileFor, root } from "./helpers.mjs";

function directory(t) {
  const path = mkdtempSync(join(tmpdir(), "assistant-concurrency-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

test("new local and hosted profiles default to eight without overriding explicit limits", (t) => {
  const local = initProfile(join(directory(t), "local"), "local:test");
  assert.equal(local.config.concurrency, 8);
  assert.equal(
    JSON.parse(readFileSync(join(local.path, "profile.json"))).concurrency,
    8,
  );
  const binding = {
    serverId: "server",
    botId: "bot",
    assignmentId: "claim",
    owner: { kind: "human", id: "human" },
  };
  const server = directory(t);
  assert.equal(provisionBotProfile(server, binding).config.concurrency, 8);
  // Existing profile provisioning does not silently change its chosen limit.
  const limited = profileFor(t, { concurrency: 2 });
  const bytes = readFileSync(join(limited.path, "profile.json"));
  assert.equal(loadProfile(limited.path).config.concurrency, 2);
  assert.deepEqual(readFileSync(join(limited.path, "profile.json")), bytes);
  const second = { ...binding, botId: "limited-bot" };
  provisionBotProfile(server, second, { concurrency: 2 });
  assert.equal(
    provisionBotProfile(server, second, { concurrency: 8 }).config.concurrency,
    2,
  );
});

test("missing concurrency resolves to eight without rewriting the persisted profile", (t) => {
  const p = profileFor(t),
    file = join(p.path, "profile.json");
  const config = JSON.parse(readFileSync(file));
  delete config.concurrency;
  writeFileSync(file, JSON.stringify(config));
  const before = readFileSync(file);
  assert.equal(loadProfile(p.path).config.concurrency, 8);
  assert.deepEqual(readFileSync(file), before);
});

test("invalid concurrency is rejected before creating a profile and on persisted load", (t) => {
  const parent = directory(t),
    p = profileFor(t),
    file = join(p.path, "profile.json"),
    original = JSON.parse(readFileSync(file));
  for (const [i, value] of [
    0,
    -1,
    9,
    1.5,
    NaN,
    Infinity,
    "8",
    null,
  ].entries()) {
    const destination = join(parent, "invalid-" + i);
    assert.throws(
      () => initProfile(destination, "local:test", { concurrency: value }),
      /concurrency must be 1\.\.8/,
    );
    assert.equal(existsSync(destination), false);
    writeFileSync(file, JSON.stringify({ ...original, concurrency: value }));
    assert.throws(() => loadProfile(p.path), /concurrency must be 1\.\.8/);
  }
});

test("real CLI init accepts configurable concurrency and reports the default; invalid values never create a profile", (t) => {
  const parent = directory(t),
    cli = join(root, "bin/assistant.mjs");
  for (const limit of [undefined, "1", "4", "8"]) {
    const destination = join(parent, "cli-" + (limit ?? "default"));
    const args = [
      cli,
      "init",
      "--profile",
      destination,
      "--owner",
      "local:test",
      ...(limit ? ["--concurrency", limit] : []),
    ];
    const output = JSON.parse(
      execFileSync(process.execPath, args, { cwd: root, encoding: "utf8" }),
    );
    assert.equal(output.concurrency, Number(limit ?? 8));
    assert.equal(
      loadProfile(destination).config.concurrency,
      Number(limit ?? 8),
    );
  }
  for (const [i, limit] of ["0", "9", "1.2", "nope", ""].entries()) {
    const destination = join(parent, "invalid-cli-" + i);
    const result = spawnSync(
      process.execPath,
      [
        cli,
        "init",
        "--profile",
        destination,
        "--owner",
        "local:test",
        "--concurrency",
        limit,
      ],
      { cwd: root, encoding: "utf8" },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /concurrency must be 1\.\.8/);
    assert.equal(existsSync(destination), false);
  }
  const result = spawnSync(
    process.execPath,
    [cli, "status", "--profile", parent, "--concurrency", "4"],
    { cwd: root, encoding: "utf8" },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /only available with init/);
});

for (const limit of [1, 3, 8]) {
  test(`scheduler starts at most ${limit} Works and refills one freed slot without duplicating active work`, async (t) => {
    const profile = profileFor(t, limit === 8 ? {} : { concurrency: limit });
    const { app, uow } = createLocalDomain(profile);
    const started = [],
      releases = new Map();
    const coordinator = new WorkCoordinator({
      app,
      concurrency: profile.config.concurrency,
      executor: {
        run(work) {
          started.push(work.id);
          return new Promise((resolve) => releases.set(work.id, resolve));
        },
      },
    });
    t.after(async () => {
      coordinator.stopping = true;
      for (const resolve of releases.values()) resolve("test cleanup");
      await Promise.allSettled(
        [...coordinator.active.values()].map((x) => x.promise),
      );
      uow.close();
    });
    const ids = Array.from(
      { length: limit + 1 },
      (_, i) =>
        app.works.submit("concurrent-" + i, {
          text: "independent work " + i,
          completion: { output: "text" },
        }).workId,
    );
    coordinator.tick();
    assert.equal(coordinator.active.size, limit);
    assert.equal(started.length, limit);
    assert.equal(app.workRecord(ids.at(-1)).status, "queued");
    coordinator.tick();
    assert.equal(started.length, limit, "tick must not restart active work");
    const first = started[0],
      task = coordinator.active.get(first);
    releases.get(first)("completed first work");
    await task.promise;
    assert.equal(coordinator.active.size, limit - 1);
    coordinator.tick();
    assert.equal(coordinator.active.size, limit);
    assert.equal(started.length, limit + 1);
    assert.equal(new Set(started).size, limit + 1);
    assert.ok(
      started.includes(ids.at(-1)),
      "waiting work acquires the freed slot",
    );
    for (const resolve of releases.values()) resolve("finished");
    await Promise.all([...coordinator.active.values()].map((x) => x.promise));
    assert.equal(coordinator.active.size, 0);
    assert.equal(app.status().works.length, limit + 1);
    assert.ok(
      ids.every((id) => app.workRecord(id).status === "awaiting_delivery"),
    );
    assert.equal(
      app.outcomes.pending().length,
      limit + 1,
      "every result waits for its own delivery acceptance",
    );
  });
}
