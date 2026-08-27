import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const packageJson = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')) as {
  pnpm?: {
    patchedDependencies?: Record<string, string>;
  };
};
const nextConfigSource = readFileSync(resolve(repoRoot, 'next.config.mjs'), 'utf8');
const globalCssSource = readFileSync(resolve(repoRoot, 'src/app/global.css'), 'utf8');

describe('AgentChat CSS boundary', () => {
  it('keeps the bundler alias pointed at the installed no-reset Tea build', () => {
    expect(nextConfigSource).toContain('@tencent/tea-component/dist/tea-themeable.css');
    expect(nextConfigSource).toContain('@tencent/tea-component/dist/tea-no-reset.css');
    expect(nextConfigSource).not.toContain('tea-themeable-no-reset.css');

    const teaPackageJson = require.resolve('@tencent/tea-component/package.json', {
      paths: [repoRoot],
    });
    const teaRoot = dirname(teaPackageJson);
    expect(existsSync(resolve(teaRoot, 'dist/tea-no-reset.css'))).toBe(true);
  });

  it('does not retain a patch configuration for the removed AgentChat 0.3.1 build', () => {
    expect(packageJson.pnpm?.patchedDependencies?.['@tencent/agentchat-claw-components@0.3.1']).toBeUndefined();
  });

  // SDK 1.4.2 起，next.config.mjs 的 alias 已能拦截 tea-themeable 污染（实测侧栏
  // <a> 不再变蓝），global.css 里的 `html a { revert-layer }` 防护已移除。
  // 这里钉死「防护不应回归」——若未来 SDK 退化、有人重新加回防护，需同步更新
  // 此断言与 next.config.mjs 的 alias 说明，而不是无脑恢复旧代码。
  it('no longer carries the obsolete html-a revert-layer guard', () => {
    // 用行首正则匹配「实际生效的规则」：注释里的恢复示例带 ` * ` 前缀不会命中，
    // 只有真正的顶层 `html a { ... }` 规则才会命中。
    expect(globalCssSource).not.toMatch(/^html a(?::hover)?\s*\{/m);
  });

  it('keeps styles.css inside the app layer', () => {
    expect(globalCssSource).toContain("@import '../styles.css' layer(app);");
    expect(globalCssSource).toMatch(/@layer\s+theme,\s*base,\s*app,\s*components,\s*utilities;/);
  });
});
