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

  // 回归防护：Tea 的全局 reset 由 SDK 深层依赖
  // (@tencent/lightai-web-cloud-lighthouse-components 的 Assistant) 以无层样式引入，
  // 会越过特异性盖掉宿主层内的链接色。global.css 末尾的无层中和规则一旦被删，
  // 侧栏导航就会重新变成链接蓝，因此在此钉死。
  it('neutralises the unlayered Tea link reset so host layers keep control', () => {
    const neutraliser = globalCssSource.slice(globalCssSource.indexOf('html a {'));

    expect(neutraliser).toContain('html a {');
    expect(neutraliser).toContain('html a:hover {');
    expect(neutraliser).toMatch(/html a \{[^}]*color:\s*revert-layer/);
    expect(neutraliser).toMatch(/html a \{[^}]*text-decoration:\s*revert-layer/);
    expect(neutraliser).toMatch(/html a:hover \{[^}]*text-decoration:\s*revert-layer/);
  });

  it('keeps styles.css inside the app layer that the neutraliser reverts to', () => {
    expect(globalCssSource).toContain("@import '../styles.css' layer(app);");
    expect(globalCssSource).toMatch(/@layer\s+theme,\s*base,\s*app,\s*components,\s*utilities;/);
  });
});
