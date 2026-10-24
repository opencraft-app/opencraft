const assert = require("node:assert/strict");
const test = require("node:test");
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const root = path.resolve(__dirname, "../..");

function isolated(script) {
  execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { cwd: root, stdio: "pipe" });
}

test("native locale bootstrap repairs missing Hermes Intl.Locale before shared runtime startup", () => {
  isolated(`
    import assert from 'node:assert/strict';
    Object.defineProperty(Intl, 'Locale', { configurable: true, writable: true, value: undefined });
    const api = await import('@opencraft/i18n');
    assert.throws(() => new api.LocaleRuntime([]), TypeError);
    await import('./apps/mobile/src/runtime/native-intl-polyfills.ts');
    const runtime = new api.LocaleRuntime([{ locale: 'zh-TW', label: 'Chinese', load: async () => ({ hello: '你好' }) }]);
    assert.equal(runtime.getSnapshot().direction, 'ltr');
    assert.equal(api.resolveBestLocale('zh-Hant', ['zh-CN', 'zh-TW']), 'zh-TW');
    assert.equal(api.getLocaleTextDirection('ar-EG'), 'rtl');
    assert.equal(api.getLocaleTextDirection('he'), 'rtl');
    await runtime.update({ localeOverride: 'zh-Hant' });
    assert.equal(runtime.getSnapshot().intl.locale, 'zh-TW');
    assert.equal(runtime.getSnapshot().intl.formatMessage({ id: 'hello', defaultMessage: 'Hello' }), '你好');
    runtime.dispose();
  `);
});

test("native locale bootstrap preserves an existing Intl.Locale constructor", () => {
  isolated(`
    import assert from 'node:assert/strict';
    const original = Intl.Locale;
    await import('./apps/mobile/src/runtime/native-intl-polyfills.ts');
    assert.equal(Intl.Locale, original);
  `);
});
