import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfigFromFile } from "vite";

test("actual Vite configuration excludes private embedding unless explicitly selected", async t => {
  const keys = ["OPENCRAFT_BUILD_TARGET", "OPENCRAFT_EMBEDDED_PRODUCT_ENTRY"];
  const before = keys.map(key => process.env[key]);
  t.after(() => keys.forEach((key, i) => before[i] === undefined ? delete process.env[key] : process.env[key] = before[i]));
  for (const key of keys) delete process.env[key];
  const configFile = path.resolve(import.meta.dirname, "../../apps/workbench-web/vite.config.ts");
  const load = async () => (await loadConfigFromFile({ command: "build", mode: "production" }, configFile)).config;
  const plain = await load();
  assert.deepEqual(Object.keys(plain.build.rolldownOptions.input), ["workbench"]);
  assert.equal(plain.plugins.flat(Infinity).some(plugin => plugin?.name === "opencraft-embedded-workbench-dev-entry"), false);

  const directory = await mkdtemp(path.join(tmpdir(), "embedded product "));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const entry = path.join(directory, "entry.ts");
  await writeFile(entry, "export {};\n");
  process.env.OPENCRAFT_EMBEDDED_PRODUCT_ENTRY = entry;
  const selected = await load();
  const bootstrap = selected.build.rolldownOptions.input["embedded-workbench"];
  assert.notEqual(bootstrap, entry, "product evaluation is behind the core compatibility boundary");
  const plugin = selected.plugins.flat(Infinity).find(plugin => plugin?.name === "opencraft-embedded-workbench-dev-entry");
  assert.ok(plugin);
  assert.equal(plugin.resolveId(bootstrap), bootstrap);
  const bootstrapSource = plugin.load(bootstrap);
  assert.match(bootstrapSource, /browser-compatibility\.ts/);
  assert.ok(bootstrapSource.endsWith(`await import(${JSON.stringify(entry)});\n`));
  let loader;
  plugin.configureServer({ middlewares: { use(url, handler) {
    assert.equal(url, "/__opencraft/embedded-workbench.js");
    handler({}, { setHeader() {}, end(value) { loader = value; } });
  } } });
  assert.ok(loader.includes(JSON.stringify(`/@fs/${entry}`)), "dev loader imports the selected local entry, including paths with spaces");
  assert.ok(selected.server.fs.allow.includes(directory));

  process.env.OPENCRAFT_BUILD_TARGET = "embedded-workbench";
  const embedded = await load();
  assert.deepEqual(embedded.build.rolldownOptions.input, { "embedded-workbench": bootstrap });
  delete process.env.OPENCRAFT_EMBEDDED_PRODUCT_ENTRY;
  await assert.rejects(load(), /Embedded Workbench build requires OPENCRAFT_EMBEDDED_PRODUCT_ENTRY/);
});
