import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildHeadlessWeb,
  resolveProductPrefix,
  headlessWebBuildEnvironment,
  headlessWebHostDefinitions,
  workbenchWebBuildSteps,
} from "../../scripts/packaging/headless-web-build.mjs";
import * as packaging from "../../scripts/packaging/package-headless-linux.mjs";

const root = new URL("../../", import.meta.url);
const release = { schemaVersion: 1, buildId: "fixture", headlessServer: true, headlessHostId: "opencraft-server" };

function recorder() {
  const calls = [];
  const verified = [];
  return {
    calls,
    verified,
    run: async (command, args, options) => void calls.push({ command, args, ...options }),
    verify: async (webRoot) => (verified.push(webRoot), release),
  };
}

test("headless Web build environment names the server Host entry", () => {
  const env = headlessWebBuildEnvironment();
  assert.deepEqual(Object.keys(env).sort(), [
    "OPENCRAFT_HEADLESS_SERVER_BUILD",
    "VITE_APPSERVER_HOSTS_JSON",
    "VITE_HYPERNODE_PLUGIN",
  ]);
  assert.equal(env.OPENCRAFT_HEADLESS_SERVER_BUILD, "true");
  assert.equal(env.VITE_HYPERNODE_PLUGIN, "disabled");
  assert.deepEqual(JSON.parse(env.VITE_APPSERVER_HOSTS_JSON), headlessWebHostDefinitions());
  assert.equal(packaging.headlessWebHostDefinitions, headlessWebHostDefinitions);
});

test("default recipe runs the release script with headless variables, then verifies dist", async () => {
  const fake = recorder();
  assert.equal(await buildHeadlessWeb({ run: fake.run, verify: fake.verify }), release);
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].command, "npm");
  assert.deepEqual(fake.calls[0].args, ["run", "build:web:release"]);
  assert.equal(new URL(`file://${fake.calls[0].cwd}/`).href, root.href);
  assert.deepEqual(fake.calls[0].env, headlessWebBuildEnvironment());
  assert.deepEqual(fake.verified, [new URL("apps/workbench-web/dist", root).pathname]);
});

test("caller variables are added but cannot override the headless variables", async () => {
  const fake = recorder();
  await buildHeadlessWeb({
    script: "build:custom",
    env: {
      OPENCRAFT_SOURCE_REVISION: "abc",
      OPENCRAFT_HEADLESS_SERVER_BUILD: "false",
      VITE_HYPERNODE_PLUGIN: "enabled",
    },
    run: fake.run,
    verify: fake.verify,
  });
  assert.deepEqual(fake.calls[0].args, ["run", "build:custom"]);
  assert.deepEqual(fake.calls[0].env, { OPENCRAFT_SOURCE_REVISION: "abc", ...headlessWebBuildEnvironment() });
});

test("an installation Vite config runs core's Web build steps with that config", async () => {
  const fake = recorder();
  const viteConfig = "/installation/vite.config.mjs";
  await buildHeadlessWeb({ viteConfig, env: { OPENCRAFT_BUILD_ID: "fixture" }, run: fake.run, verify: fake.verify });
  assert.deepEqual(
    fake.calls.map(({ command, args }) => [command, args.at(-1)]),
    [
      ["npm", "build:preview-bridge"],
      [process.execPath, "../../scripts/postinstall/patch-novnc-desktop-events.mjs"],
      [process.execPath, viteConfig],
      [process.execPath, "../../scripts/check/check-browser-compatibility.mjs"],
    ],
  );
  assert.match(fake.calls[2].args[0], /node_modules\/vite\/bin\/vite\.js$/);
  assert.deepEqual(fake.calls[2].args.slice(1), ["build", "--config", viteConfig]);
  for (const call of fake.calls.slice(1)) {
    assert.equal(new URL(`file://${call.cwd}/`).href, new URL("apps/workbench-web/", root).href);
  }
  for (const call of fake.calls) {
    assert.deepEqual(call.env, {
      OPENCRAFT_BUILD_ID: "fixture",
      ...headlessWebBuildEnvironment(),
      OPENCRAFT_RELEASE_MINIFY: "standard",
    });
  }
  assert.equal(fake.verified.length, 1);
});

test("a product prefix runs that project's Web script, not a root one", async () => {
  const fake = recorder();
  // runtime/dsh is a committed separately locked project, so it serves as a prefix fixture.
  await buildHeadlessWeb({ script: "build:web", prefix: "runtime/dsh", run: fake.run, verify: fake.verify });
  assert.deepEqual(fake.calls[0].args, ["--prefix", new URL("runtime/dsh", root).pathname, "run", "build:web"]);
  assert.equal(new URL(`file://${fake.calls[0].cwd}/`).href, root.href);
  assert.deepEqual(fake.verified, [new URL("apps/workbench-web/dist", root).pathname]);
  await assert.rejects(
    buildHeadlessWeb({ prefix: "runtime/dsh", viteConfig: "/a.mjs", run: fake.run }),
    /prefix selects a script/,
  );
});

test("a product prefix must be a locked project inside the repository", async (t) => {
  const repository = await mkdtemp(join(tmpdir(), "opencraft-product-prefix-"));
  t.after(() => rm(repository, { recursive: true, force: true }));
  const project = async (path, files = ["package.json", "package-lock.json"]) => {
    await mkdir(join(repository, path), { recursive: true });
    for (const file of files) await writeFile(join(repository, path, file), "{}");
  };
  await project("products/example");
  await project("products/unlocked", ["package.json"]);
  await project("outside");
  await symlink(join(repository, "outside"), join(repository, "products/linked"));
  assert.equal(resolveProductPrefix("products/example", repository), join(repository, "products/example"));
  for (const prefix of [
    "",
    ".",
    "/products/example",
    "products/example/",
    "products/../products/example",
    "products//example",
    "../outside",
    "products/unlocked",
    "products/missing",
    "products/linked",
  ])
    assert.throws(() => resolveProductPrefix(prefix, repository), undefined, prefix);
});

test("core Web build steps stay equal to the workspace build script", async () => {
  const manifest = JSON.parse(await readFile(new URL("apps/workbench-web/package.json", root), "utf8"));
  const script = workbenchWebBuildSteps()
    .map(([command, args]) => [command, ...args].join(" "))
    .join(" && ");
  assert.equal(manifest.scripts.build, script);
});

test("invalid recipes and failed verification are refused", async () => {
  const fake = recorder();
  await assert.rejects(
    buildHeadlessWeb({ script: "x", viteConfig: "/a.mjs", run: fake.run }),
    /either script or viteConfig/,
  );
  await assert.rejects(buildHeadlessWeb({ viteConfig: "vite.config.mjs", run: fake.run }), /absolute path/);
  assert.deepEqual(fake.calls, []);
  await assert.rejects(
    buildHeadlessWeb({
      run: fake.run,
      verify: async () => {
        throw new Error("not a headless build");
      },
    }),
    /not a headless build/,
  );
});
