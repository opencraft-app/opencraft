import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ExtensionSupervisor } from "@opencraft/extension-runtime";
import { APPLICATION_BRANDING_CHANNEL, DEFAULT_APPLICATION_BRANDING, isApplicationBranding } from "@opencraft/extension-contract";
import { ApplicationBrandingRegistry } from "../../apps/workbench-web/src/runtime/application-branding";
import { pluginBranding } from "../../apps/workbench-web/plugin-branding.vite";
const TestBrandExtension = {
  manifest: { manifestVersion: 1 as const, id: "test.branding", version: "0.1.0", apiVersion: 1 as const, trust: "trusted" as const, name: "Test branding", platforms: ["web" as const], activationEvents: ["onStartupFinished"] },
  activate(api: import("@opencraft/extension-runtime").TrustedExtensionApiV1) {
    api.internal.register(APPLICATION_BRANDING_CHANNEL, { id: "test.branding", name: "Test server", markUrl: "/opencraft-icon.svg" });
  },
};
import { parseWebDeploymentConfig, resolveWebDeploymentConfig } from "../../apps/workbench-web/src/runtime/web-deployment-config";

test("Packaged branding is opt-in; explicit runtime configuration and build override select plugins", () => {
  assert.equal(resolveWebDeploymentConfig(null, {}).extensions, undefined);
  const config = parseWebDeploymentConfig(JSON.stringify({ hosts: [], builtinAgents: false, hypernode: false, extensions: ["test.branding"] }));
  assert.deepEqual(resolveWebDeploymentConfig(config, {}).extensions, ["test.branding"]);
  assert.deepEqual(resolveWebDeploymentConfig(config, { extensions: "" }).extensions, []);
  assert.throws(() => parseWebDeploymentConfig(JSON.stringify({ hosts: [], builtinAgents: false, hypernode: false, extensions: [1] })), /extension/);
});

test("trusted brand activation, unload, replacement and rollback use the existing lifetime", async t => {
  const registry = new ApplicationBrandingRegistry();
  const supervisor = new ExtensionSupervisor({ platform: "web", internalContributions: { [APPLICATION_BRANDING_CHANNEL]: registry.createAdapter(), fail: { prepare: () => ({ commit: () => { throw Error("fixture failure"); } }) } } });
  t.after(() => supervisor.dispose());
  const current = () => registry.getSnapshot().contribution ?? DEFAULT_APPLICATION_BRANDING;
  assert.equal(current().name, "OpenCraft");
  await supervisor.activate(TestBrandExtension);
  assert.equal(current().name, "Test server");
  assert.equal(current().manifestUrl, undefined);
  assert.notEqual(current().showMarkOnMobile, false);
  const replacement = { manifest: { ...TestBrandExtension.manifest, id: "test.brand" }, activate(api: Parameters<typeof TestBrandExtension.activate>[0]) {
    api.internal.register(APPLICATION_BRANDING_CHANNEL, { id: "test.brand", name: "Another server", markUrl: "/another.svg" });
  } };
  await assert.rejects(supervisor.activate(replacement), /owner/);
  assert.equal(current().name, "Test server");
  await supervisor.deactivate(TestBrandExtension.manifest.id);
  assert.equal(current().name, "OpenCraft");
  await supervisor.activate(replacement);
  assert.equal(current().name, "Another server");
  await supervisor.deactivate(replacement.manifest.id);
  await assert.rejects(supervisor.activate({ manifest: { ...replacement.manifest, id: "test.rollback" }, activate(api) {
    api.internal.register(APPLICATION_BRANDING_CHANNEL, { id: "test.rollback", name: "Temporary" }); api.internal.register("fail", {});
  } }), /fixture failure/);
  assert.equal(current().name, "OpenCraft");
});

test("branding data accepts same-origin assets and rejects executable or external URLs", () => {
  for (const markUrl of ["javascript:alert(1)", "//example.com/icon", "https://example.com/icon", "/\\example.com"]) assert.equal(isApplicationBranding({ id: "test", name: "Test", markUrl }), false);
  assert.equal(isApplicationBranding({ id: "test", name: "Test", markUrl: "/plugin-assets/test/icon.svg" }), true);
  for (const showMarkOnMobile of [true, false, undefined]) assert.equal(isApplicationBranding({ id: "test", name: "Test", showMarkOnMobile }), true);
  for (const showMarkOnMobile of ["false", null, 0]) assert.equal(isApplicationBranding({ id: "test", name: "Test", showMarkOnMobile }), false);
  const share = { publicOrigin: "https://brand.example", imageUrl: "/plugin-assets/test/share.jpg", description: "Public workspace" };
  assert.equal(isApplicationBranding({ id: "test", name: "Test", share }), true);
  for (const publicOrigin of ["http://brand.example", "https://brand.example/path", "https://user:password@brand.example", "javascript:alert(1)", "not a URL"]) {
    assert.equal(isApplicationBranding({ id: "test", name: "Test", share: { ...share, publicOrigin } }), false);
  }
  for (const imageUrl of ["//another.example/image.jpg", "https://another.example/image.jpg", "javascript:alert(1)"]) {
    assert.equal(isApplicationBranding({ id: "test", name: "Test", share: { ...share, imageUrl } }), false);
  }
  for (const invalid of [null, "image", {}, { ...share, description: " " }]) {
    assert.equal(isApplicationBranding({ id: "test", name: "Test", share: invalid }), false);
  }
});

test("the production Vite config loads in plain Node without a TypeScript runtime loader", async () => {
  const { spawnSync } = await import("node:child_process");
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", 'import {loadConfigFromFile} from "vite"; await loadConfigFromFile({command:"build",mode:"production"},"apps/workbench-web/vite.config.ts");'], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("generic plugin assets and initial metadata follow their declared owner", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "opencraft-brand-fixture-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const plugin = path.join(root, "plugins/example");
  await mkdir(path.join(plugin, "public"), { recursive: true });
  await writeFile(path.join(plugin, "package.json"), JSON.stringify({ opencraft: {
    extensionId: "example.brand", webBranding: "branding.json", webAssets: "public",
  } }));
  await writeFile(path.join(plugin, "branding.json"), JSON.stringify({ id: "example.brand", name: "Example server", markUrl: "/plugin-assets/example/mark.svg", faviconUrl: "/plugin-assets/example/mark.svg" }));
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><circle cx="8" cy="8" r="8"/></svg>';
  await writeFile(path.join(plugin, "public/mark.svg"), svg);
  const html = '<head><title>OpenCraft</title><link rel="icon" href="/opencraft-icon.svg"></head>';
  const neutral = pluginBranding(root, []), selected = pluginBranding(root, ["example.brand"]);
  assert.equal((neutral.transformIndexHtml as Function)(html), html);
  const result = (selected.transformIndexHtml as Function)(html);
  assert.match(result.html, /<title>Example server<\/title>/);
  assert.ok(result.tags.some((tag: any) => tag.attrs.rel === "icon" && tag.attrs.href === "/plugin-assets/example/mark.svg"));
  const files: any[] = [];
  (selected.generateBundle as Function).call({ emitFile: (file: unknown) => files.push(file) });
  assert.deepEqual(files.map(({ fileName, source }) => [fileName, source.toString()]), [["plugin-assets/example/mark.svg", svg]]);
});
