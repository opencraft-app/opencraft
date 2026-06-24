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
const clawPatchPath = 'patches/@tencent__agentchat-claw-components@0.3.1.patch';
const clawPatchSource = readFileSync(resolve(repoRoot, clawPatchPath), 'utf8');

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

  it('patches AgentChat imports away from Tea global reset CSS', () => {
    expect(packageJson.pnpm?.patchedDependencies?.['@tencent/agentchat-claw-components@0.3.1']).toBe(
      clawPatchPath,
    );

    expect(clawPatchSource).toContain('diff --git a/dist/es/assistant/index.js');
    expect(clawPatchSource).toContain('diff --git a/dist/es/clawbot/components/claw-messages-box.js');
    expect(clawPatchSource).toContain("+import '@tencent/tea-component/dist/tea-no-reset.css';");
    expect(clawPatchSource).not.toContain(
      "+import '@tencent/tea-component/dist/tea-themeable.css';",
    );
  });
});
