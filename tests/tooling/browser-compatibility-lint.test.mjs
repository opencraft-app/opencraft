import assert from "node:assert/strict";
import test from "node:test";
import { ESLint } from "eslint";
import { fileURLToPath } from "node:url";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import browserConfig from "../../config/eslint.browser.config.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
// lintText simulates changing editor buffers; CI's immutable Program assumes
// on-disk source and would otherwise bind these snippets to the real file.
const eslint = new ESLint({ cwd: root, allowInlineConfig: false,
  overrideConfigFile: true,
  overrideConfig: [...browserConfig, { languageOptions: { parserOptions: { disallowAutomaticSingleRunInference: true } } }],
});
// Use the real browser TS project, including its transitive ESNext declarations.
const filePath = `${root}apps/workbench-web/src/browser/browser-workbench-coordinator.ts`;
const lint = async code => (await eslint.lintText(code, { filePath }))[0].messages;

for (const [name, code, rule] of [
  ["typed Map parameter", "function f(tabs: Map<string, {pageId: string}>) { return tabs.values().map(t => t.pageId); }", "es-x/no-iterator-prototype-map"],
  ["class field as in browser restoration", "class X { tabs = new Map<string, {pageId: string}>(); restore() { return this.tabs.values().map(t => t.pageId); } }", "es-x/no-iterator-prototype-map"],
  ["other iterator helpers", "new Map().values().filter(Boolean);", "es-x/no-iterator-prototype-filter"],
  ["Promise.withResolvers", "Promise.withResolvers();", "es-x/no-promise-withresolvers"],
  ["Set methods", "new Set().union(new Set());", "es-x/no-set-prototype-union"],
  ["native Popover", "document.createElement('div').showPopover();", "no-restricted-properties"],
  ["AbortSignal.any", "const request = new AbortController(); const options: RequestInit = { signal: AbortSignal.any([request.signal, AbortSignal.timeout(10_000)]) };", "no-restricted-properties"],
  ["computed AbortSignal['any']", "const request = new AbortController(); AbortSignal['any']([request.signal]);", "no-restricted-properties"],
  ["employee identity RequestInit", "class EmployeeIdentity { request = new AbortController(); options(): RequestInit { return { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: AbortSignal.any([this.request.signal, AbortSignal.timeout(10_000)]) }; } }", "no-restricted-properties"],
  ["unavailable browser global", "window.requestIdleCallback(() => {});", "compat/compat"],
]) {
  test(`browser lint rejects ${name}`, async () => {
    const messages = await lint(code);
    assert.ok(messages.some(message => message.ruleId === rule), JSON.stringify(messages));
    assert.ok(!messages.some(message => message.fatal), JSON.stringify(messages));
  });
}
test("browser lint accepts arrays, Array.from migration and feature detection with fallback", async () => {
  assert.deepEqual(await lint(`
    const tabs = new Map<string, {pageId: string}>();
    [1, 2].map(x => x + 1);
    Array.from(tabs.values(), tab => tab.pageId);
    if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(() => {});
    else setTimeout(() => {}, 0);
  `), []);
});
test("browser lint accepts AbortController signals and unrelated any properties", async () => {
  assert.deepEqual(await lint(`
    const request = new AbortController();
    const signal: AbortSignal = request.signal;
    AbortSignal.timeout(10_000);
    const helper = { any: (values: AbortSignal[]) => values[0]! };
    helper.any([signal]);
  `), []);
});
test("unrelated inline lint directives do not break compatibility checks", async () => {
  assert.deepEqual(await lint("// eslint-disable-next-line react-hooks/exhaustive-deps\n[1].map(x => x);"), []);
});

test("immutable CI Programs reject iterator helpers in real runtime files", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "opencraft-browser-lint-"));
  const previous = process.env.TSESTREE_SINGLE_RUN;
  try {
    await writeFile(join(temporary, "tsconfig.json"), JSON.stringify({ compilerOptions: { lib: ["ESNext", "DOM"], strict: true }, include: ["fixture.ts"] }));
    const file = join(temporary, "fixture.ts");
    await writeFile(file, "class X { tabs = new Map<string, {pageId: string}>(); restore() { return this.tabs.values().map(t => t.pageId); } } [1, 2].map(x => x + 1);");
    process.env.TSESTREE_SINGLE_RUN = "true";
    const checker = new ESLint({ cwd: temporary, allowInlineConfig: false, overrideConfigFile: true,
      overrideConfig: [...browserConfig, { languageOptions: { parserOptions: {
        project: join(temporary, "tsconfig.json"), tsconfigRootDir: temporary,
      } } }],
    });
    const [result] = await checker.lintFiles([file]);
    assert.deepEqual(result.messages.map(message => message.ruleId), ["es-x/no-iterator-prototype-map"]);
  } finally {
    if (previous === undefined) delete process.env.TSESTREE_SINGLE_RUN;
    else process.env.TSESTREE_SINGLE_RUN = previous;
    await rm(temporary, { recursive: true, force: true });
  }
});


test("independently owned plugin files retain typed browser compatibility checks", async () => {
  // This file is outside the Web program. lintText models a plugin entering the
  // build graph; it does not make the server adapter a browser entrypoint.
  const pluginPath = `${root}plugins/local-account/src/server.ts`;
  const [unsafe] = await eslint.lintText("function f(tabs: Map<string, number>) { return tabs.values().map(x => x); }", { filePath: pluginPath });
  assert.ok(!unsafe.messages.some(message => message.fatal), JSON.stringify(unsafe.messages));
  assert.ok(unsafe.messages.some(message => message.ruleId === "es-x/no-iterator-prototype-map"), JSON.stringify(unsafe.messages));
  const [safe] = await eslint.lintText("function f(tabs: Map<string, number>) { return Array.from(tabs.values(), x => x); }", { filePath: pluginPath });
  assert.deepEqual(safe.messages, []);
});
