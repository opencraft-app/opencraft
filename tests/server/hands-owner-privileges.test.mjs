import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { chmod, chown, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HANDS_OWNER_PROCESSES, startContainerHands } from "../../scripts/container-deployment/hands-application.mjs";
import {
  handsOwnerSpawnOptions,
  resolveHandsOwnerPrivileges,
} from "../../scripts/container-deployment/hands-owner-privileges.mjs";

const roles = HANDS_OWNER_PROCESSES.map((owner) => owner.role);
const isRoot = process.getuid?.() === 0;
// As root the fixtures belong to a separate unprivileged identity; otherwise the
// test process's own identity stands in for it and the supervisor UID is injected.
const target = isRoot ? { uid: 47123, gid: 47123 } : { uid: process.getuid(), gid: process.getgid() };

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "opencraft-hands-privileges-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  // Traversable but not listable, so a dropped child can reach its own directories.
  await chmod(root, 0o711);
  const browser = join(root, "browser"),
    home = join(root, "home");
  for (const path of [browser, home]) {
    await mkdir(path, { mode: 0o700 });
    if (isRoot) await chown(path, target.uid, target.gid);
  }
  return { root, browser, home };
}

const resolveAs = (policy, environment, currentUid = 0) =>
  resolveHandsOwnerPrivileges(policy, { roles, environment, currentUid });

test("an absent or empty policy resolves to no drops without touching the filesystem", () => {
  const stat = () => assert.fail("no directory should be inspected");
  assert.deepEqual(resolveHandsOwnerPrivileges(undefined, { roles, environment: {}, currentUid: 1000, stat }), {});
  assert.deepEqual(resolveHandsOwnerPrivileges({}, { roles, environment: {}, currentUid: 1000, stat }), {});
  const options = { cwd: "/workspace", env: { HOME: "/root" }, stdio: "inherit", shell: false };
  assert.equal(handsOwnerSpawnOptions(options, undefined), options);
});

test("policy shape errors are rejected before any directory check", () => {
  const environment = { OPENCRAFT_BROWSER_DATA_DIR: "/var/lib/opencraft/browser" };
  const cases = [
    [null, /must be an object keyed by owner role/],
    [[], /must be an object keyed by owner role/],
    [{ gateway: { uid: 1000, gid: 1000 } }, /Unknown Hands owner role "gateway"/],
    [{ browser: null }, /privileges must be an object/],
    [{ browser: { uid: 0, gid: 1000 } }, /uid must be an integer between 1/],
    [{ browser: { uid: 1000, gid: 0 } }, /gid must be an integer between 1/],
    [{ browser: { uid: "1000", gid: 1000 } }, /uid must be an integer/],
    [{ browser: { uid: 1.5, gid: 1000 } }, /uid must be an integer/],
    [{ browser: { uid: 2 ** 31, gid: 1000 } }, /uid must be an integer/],
    [{ browser: { uid: 1000, gid: 1000, dataDirectory: "/x" } }, /Unsupported .* setting "dataDirectory"/],
    [{ browser: { uid: 1000, gid: 1000, home: "relative" } }, /home must be a normalized absolute directory/],
    [{ browser: { uid: 1000, gid: 1000, home: "/srv/../root" } }, /home must be a normalized absolute directory/],
    [{ browser: { uid: 1000, gid: 1000, home: "/" } }, /home must be a normalized absolute directory/],
    [{ execution: { uid: 1000, gid: 1000 } }, /"execution" needs an explicit home directory/],
  ];
  for (const [policy, pattern] of cases) assert.throws(() => resolveAs(policy, environment), pattern);
  assert.throws(
    () => resolveAs({ browser: { uid: 1000, gid: 1000 } }, { OPENCRAFT_BROWSER_DATA_DIR: "browser" }),
    /OPENCRAFT_BROWSER_DATA_DIR must be a normalized absolute directory/,
  );
});

test("a declared drop refuses to start unless the supervisor is root", () => {
  assert.throws(
    () => resolveAs({ browser: { uid: 1000, gid: 1000 } }, { OPENCRAFT_BROWSER_DATA_DIR: "/srv/browser" }, 1000),
    /require the Hands supervisor to run as UID 0/,
  );
});

test("dropped-role directories must exist, be private, owned by the role and reached without links", async (t) => {
  const { root, browser, home } = await fixture(t);
  const environment = { OPENCRAFT_BROWSER_DATA_DIR: browser };
  const resolved = resolveAs({ browser: { ...target, home } }, environment);
  assert.deepEqual(resolved, { browser: { ...target, home, stateDirectory: browser } });
  assert.ok(Object.isFrozen(resolved) && Object.isFrozen(resolved.browser));
  // HOME defaults to the browser's own state directory.
  assert.equal(resolveAs({ browser: target }, environment).browser.home, browser);

  assert.throws(
    () => resolveAs({ browser: target }, { OPENCRAFT_BROWSER_DATA_DIR: join(root, "missing") }),
    /is not accessible \(ENOENT\)/,
  );
  const link = join(root, "link");
  await symlink(browser, link);
  assert.throws(
    () => resolveAs({ browser: target }, { OPENCRAFT_BROWSER_DATA_DIR: link }),
    /must be a directory, not a link/,
  );
  const inside = join(browser, "inside");
  await mkdir(inside, { mode: 0o700 });
  if (isRoot) await chown(inside, target.uid, target.gid);
  assert.throws(
    () => resolveAs({ browser: target }, { OPENCRAFT_BROWSER_DATA_DIR: join(link, "inside") }),
    /ancestor .*link must be a directory, not a link/,
  );
  assert.throws(
    () => resolveAs({ browser: { uid: target.uid + 1, gid: target.gid } }, environment),
    /state directory .* must be owned by/,
  );
  assert.throws(
    () => resolveAs({ browser: { ...target, home: root } }, environment),
    /home .* must be owned by|home .* must not be accessible/,
  );
  await chmod(home, 0o750);
  assert.throws(
    () => resolveAs({ browser: { ...target, home } }, environment),
    /must not be accessible to group or others/,
  );
  await chmod(home, 0o700);

  // A group-writable, non-sticky ancestor lets another user swap the directory.
  const shared = join(root, "shared"),
    nested = join(shared, "browser");
  await mkdir(shared, { mode: 0o777 });
  await chmod(shared, 0o777);
  await mkdir(nested, { mode: 0o700 });
  if (isRoot) await chown(nested, target.uid, target.gid);
  assert.throws(
    () => resolveAs({ browser: target }, { OPENCRAFT_BROWSER_DATA_DIR: nested }),
    /ancestor .* must not be replaceable by another user/,
  );
});

test("a dropped role receives its identity and a HOME without the supervisor's user directories", () => {
  const base = {
    cwd: "/workspace",
    env: { PATH: "/usr/bin", HOME: "/root", XDG_CONFIG_HOME: "/root/.config", XDG_RUNTIME_DIR: "/run/user/0" },
    stdio: "inherit",
    shell: false,
  };
  const mapped = handsOwnerSpawnOptions(base, { uid: 1000, gid: 1001, home: "/srv/home" });
  assert.deepEqual(mapped, {
    cwd: "/workspace",
    env: { PATH: "/usr/bin", HOME: "/srv/home" },
    stdio: "inherit",
    shell: false,
    uid: 1000,
    gid: 1001,
  });
  assert.equal(base.env.HOME, "/root", "the shared base options are not mutated");
});

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

async function runHands(t, environment, options) {
  const previous = { environment: {}, exitCode: process.exitCode };
  for (const key of Object.keys(environment)) previous.environment[key] = process.env[key];
  const signals = { SIGINT: process.listeners("SIGINT"), SIGTERM: process.listeners("SIGTERM") };
  t.after(() => {
    for (const [key, value] of Object.entries(previous.environment))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    process.exitCode = previous.exitCode;
    for (const [name, before] of Object.entries(signals))
      for (const listener of process.listeners(name))
        if (!before.includes(listener)) process.removeListener(name, listener);
  });
  Object.assign(process.env, environment);
  const calls = [],
    children = [];
  const spawnOwner = (command, args, spawnOptions, owner) => {
    const child = fakeChild();
    calls.push({ options: spawnOptions, owner });
    children.push(child);
    if (children.length === HANDS_OWNER_PROCESSES.length) setImmediate(() => children[0].exit(0));
    return child;
  };
  await startContainerHands({ spawnOwner, ...options });
  return calls;
}

test("without a policy every owner keeps the supervisor identity and environment", async (t) => {
  const { browser } = await fixture(t);
  const data = join(browser, "own");
  const calls = await runHands(t, { OPENCRAFT_BROWSER_DATA_DIR: data }, {});
  assert.deepEqual(
    calls.map((call) => call.owner.role),
    roles,
  );
  for (const { options } of calls) {
    assert.deepEqual(Object.keys(options).sort(), ["cwd", "env", "shell", "stdio"]);
    assert.equal(options.env, process.env);
  }
});

test("startup validates the policy before starting services or owners", async (t) => {
  const { browser } = await fixture(t);
  let started = false;
  await assert.rejects(
    runHands(
      t,
      { OPENCRAFT_BROWSER_DATA_DIR: browser },
      {
        ownerPrivileges: { gateway: { uid: 1000, gid: 1000 } },
        startServices: async () => {
          started = true;
          return [];
        },
        spawnOwner: () => assert.fail("no owner may start"),
      },
    ),
    /Unknown Hands owner role "gateway"/,
  );
  assert.equal(started, false);
});

test(
  "startup hands only the declared role its dropped spawn options",
  { skip: !isRoot && "requires UID 0" },
  async (t) => {
    const { browser, home } = await fixture(t);
    const calls = await runHands(
      t,
      { OPENCRAFT_BROWSER_DATA_DIR: browser, XDG_CACHE_HOME: "/root/.cache" },
      { ownerPrivileges: { browser: { ...target, home } } },
    );
    const [first, ...rest] = calls;
    assert.equal(first.owner.role, "browser");
    assert.equal(first.options.uid, target.uid);
    assert.equal(first.options.gid, target.gid);
    assert.equal(first.options.env.HOME, home);
    assert.equal(first.options.env.OPENCRAFT_BROWSER_DATA_DIR, browser);
    assert.equal(first.options.env.XDG_CACHE_HOME, undefined);
    for (const { options } of rest) {
      assert.equal(options.uid, undefined);
      assert.equal(options.env, process.env);
    }
  },
);

test(
  "a real child spawned with the mapped options runs as the dropped identity",
  { skip: !isRoot && "requires UID 0" },
  async (t) => {
    const { home } = await fixture(t);
    const options = handsOwnerSpawnOptions(
      { cwd: home, env: { PATH: "/usr/bin:/bin", HOME: "/root" }, stdio: ["ignore", "pipe", "inherit"], shell: false },
      { ...target, home },
    );
    const child = spawn("/bin/sh", ["-c", 'printf "%s %s %s %s" "$(id -u)" "$(id -g)" "$(id -G)" "$HOME"'], options);
    let output = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (output += chunk));
    const code = await new Promise((resolve, reject) => child.once("error", reject).once("close", resolve));
    assert.equal(code, 0);
    // Supplementary groups are cleared as well, so no root group membership remains.
    assert.equal(output, `${target.uid} ${target.gid} ${target.gid} ${home}`);
  },
);
