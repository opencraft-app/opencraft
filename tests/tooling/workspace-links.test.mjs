import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyWorkspaceLinks, workspacePackages } from "../../scripts/packaging/workspace-links.mjs";

async function checkout(t, root, { workspaces = ["packages/*", "apps/web"] } = {}) {
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "fixture", private: true, workspaces }));
  for (const [directory, name] of [
    ["packages/core", "@fixture/core"],
    ["packages/util", "fixture-util"],
    ["apps/web", "@fixture/web"],
  ]) {
    await mkdir(path.join(root, directory), { recursive: true });
    await writeFile(path.join(root, directory, "package.json"), JSON.stringify({ name }));
  }
  // A directory without a manifest is not a workspace package.
  await mkdir(path.join(root, "packages/notes"), { recursive: true });
  await mkdir(path.join(root, "node_modules/@fixture"), { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
const link = (root, name, target) =>
  symlink(
    path.relative(path.dirname(path.join(root, "node_modules", name)), target),
    path.join(root, "node_modules", name),
    "dir",
  );
async function linkAll(root, source = root) {
  await link(root, "@fixture/core", path.join(source, "packages/core"));
  await link(root, "fixture-util", path.join(source, "packages/util"));
  await link(root, "@fixture/web", path.join(source, "apps/web"));
}
const temporary = () => mkdtemp(path.join(tmpdir(), "workspace-links-"));

test("links that resolve into the checkout pass and every manifest package is checked", async (t) => {
  const root = await checkout(t, path.join(await temporary(), "core"));
  await linkAll(root);
  assert.deepEqual(verifyWorkspaceLinks(root).sort(), ["@fixture/core", "@fixture/web", "fixture-util"]);
  assert.deepEqual(
    workspacePackages(root)
      .map((entry) => path.relative(root, entry.directory))
      .sort(),
    ["apps/web", "packages/core", "packages/util"],
  );
});

test("a link into another checkout is rejected with the foreign target", async (t) => {
  const parent = await temporary();
  const root = await checkout(t, path.join(parent, "core"));
  const foreign = await checkout(t, path.join(parent, "other-checkout"));
  await linkAll(root);
  await rm(path.join(root, "node_modules/@fixture/core"));
  await link(root, "@fixture/core", path.join(foreign, "packages/core"));
  assert.throws(
    () => verifyWorkspaceLinks(root),
    (error) => {
      assert.match(error.message, /run npm ci in this checkout/u);
      assert.match(error.message, /@fixture\/core: links to .*other-checkout/u);
      assert.doesNotMatch(error.message, /fixture-util|@fixture\/web/u);
      return true;
    },
  );
});

test("a missing link and a dangling link are rejected", async (t) => {
  const root = await checkout(t, path.join(await temporary(), "core"));
  await linkAll(root);
  await rm(path.join(root, "node_modules/fixture-util"));
  assert.throws(() => verifyWorkspaceLinks(root), /fixture-util: not installed/u);
  await link(root, "fixture-util", path.join(root, "packages/removed"));
  assert.throws(() => verifyWorkspaceLinks(root), /fixture-util: link target does not exist/u);
});

test("a copied package directory is not accepted as a workspace link", async (t) => {
  const root = await checkout(t, path.join(await temporary(), "core"));
  await linkAll(root);
  await rm(path.join(root, "node_modules/@fixture/web"));
  await mkdir(path.join(root, "node_modules/@fixture/web"));
  await writeFile(path.join(root, "node_modules/@fixture/web/package.json"), JSON.stringify({ name: "@fixture/web" }));
  assert.throws(() => verifyWorkspaceLinks(root), /@fixture\/web: installed as a copy/u);
});

test("the checkout itself is reached through a symlinked path", async (t) => {
  const parent = await temporary();
  const root = await checkout(t, path.join(parent, "core"));
  await linkAll(root);
  await symlink(root, path.join(parent, "alias"), "dir");
  assert.equal(verifyWorkspaceLinks(path.join(parent, "alias")).length, 3);
});

test("workspace patterns that cannot be enumerated exactly fail instead of checking less", async (t) => {
  for (const pattern of ["packages/**", "packages/*/src", "!apps/web", "pack*"]) {
    const root = await checkout(t, path.join(await temporary(), "core"), { workspaces: [pattern] });
    assert.throws(() => verifyWorkspaceLinks(root), /Unsupported workspace pattern/u);
  }
});

test("this checkout's workspace packages resolve into it", () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  assert.ok(verifyWorkspaceLinks(root).includes("@opencraft/session-capabilities"));
});
