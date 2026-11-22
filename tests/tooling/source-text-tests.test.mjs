import assert from "node:assert/strict";
import test from "node:test";
import { isSourceTextTest } from "../../scripts/check/check-source-text-tests.mjs";

// Fixtures assemble the read call so this file is not itself a source-text test.
const readFileSync = ["read", "FileSync"].join("");
const readFile = ["read", "File"].join("");

test("reading product source and regex-matching it is a source-text test", () => {
  assert.equal(
    isSourceTextTest(`
    const source = ${readFileSync}(new URL("../../apps/workbench-web/src/app.tsx", import.meta.url), "utf8");
    assert.match(source, /dispose/);`),
    true,
  );
});

test("a local read helper and root-relative paths still count as reading source", () => {
  assert.equal(
    isSourceTextTest(`
    const read = (path) => ${readFileSync}(new URL(path, root), "utf8");
    const main = read("apps/desktop/src/main.ts");
    assert.match(main, /app\\.whenReady/);
    void "../../apps/desktop/src/main.ts";`),
    true,
  );
});

test("mentioning a source path to run it while regex-matching runtime output is not", () => {
  assert.equal(
    isSourceTextTest(`
    const entry = new URL("../../apps/local-agent-host/src/main.ts", import.meta.url);
    const descriptor = JSON.parse(await ${readFile}(options.descriptorPath, "utf8"));
    assert.match(descriptor.thread.id, /^claude_/);`),
    false,
  );
});
