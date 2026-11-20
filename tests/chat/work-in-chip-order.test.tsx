import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'react-intl';
import { asHostId } from '@opencraft/chat-core';
import { createConversationScopeRegistry } from '@opencraft/workbench-runtime';
import { build } from 'esbuild';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';

test('execution rail has exactly node and workspace selectors, localized, in both environment variants', async context => {
  const directory = await mkdtemp(join(process.cwd(), 'node_modules/.chip-order-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const bundle = join(directory, 'bar.cjs');
  await build({
    stdin: { contents: 'export { ExecutionUtilityBar } from "./apps/workbench-web/src/components/draft-execution-utility-bar";', resolveDir: process.cwd(), loader: 'ts' },
    outfile: bundle, bundle: true, platform: 'node', format: 'cjs',
    external: ['react', 'react/*', 'react-dom', 'react-dom/*', 'react-intl'],
    loader: { '.scss': 'empty', '.css': 'empty', '.svg': 'dataurl' },
    plugins: [{ name: 'notification-port', setup(builder) {
      builder.onResolve({ filter: /async-notices-context$/ }, () => ({ path: 'notices', namespace: 'test' }));
      builder.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: 'export const useAsyncNotices = () => ({ error() {} });', loader: 'js' }));
    } }], logLevel: 'silent',
  });
  const { ExecutionUtilityBar } = createRequire(import.meta.url)(bundle) as typeof import('../../apps/workbench-web/src/components/draft-execution-utility-bar');
  for (const locale of ['en-US', 'zh-CN']) for (const sandbox of [false, true]) {
    const messages = JSON.parse(await readFile(`apps/workbench-web/src/i18n/locales/${locale}.json`, 'utf8'));
    const scopes = createConversationScopeRegistry({ initialDraft: { draftId: 'order', execution: {
      hostId: asHostId('local'), workspace: sandbox ? { cwd: null, runtimeWorkspaceRoots: [] } : { cwd: '/project', runtimeWorkspaceRoots: ['/project'], projectId: 'project' },
      ...(sandbox ? { environment: { version: 1, configurationId: 'sandbox', templateId: 'general' } as const } : {}),
    } } });
    try {
      const markup = renderToStaticMarkup(<IntlProvider locale={locale} messages={messages}>
        <ExecutionUtilityBar portalContainer={null} draft={scopes.getActiveDraft()!}
          workspaceOptions={[{ projectId: 'project', cwd: '/project', label: 'Project', rootLabel: 'Project', runtimeWorkspaceRoots: ['/project'], branch: 'main' }]}
          workspaceOptionsLoading={false} nativeWorkspacePicking={false}
          activeHostId="local" hostOptions={[{ id: 'local', hostIds: ['local'], label: 'Machine', platform: 'linux', role: 'server', resource: null, cloud: false, connectable: true }]}
          connectionPhase="ready" onSelectHost={() => {}} onSelectWorkspace={() => {}} onBrowseWorkspace={() => {}} onReturnFocus={() => {}} />
      </IntlProvider>);
      const machine = markup.indexOf(`aria-label="${messages['workIn.title']}"`);
      const workspace = markup.indexOf(`aria-label="${messages['workspacePlacement.choose']}"`);
      assert.ok(machine >= 0 && workspace > machine);
      assert.equal((markup.match(/class="[^"]*new-thread-context-trigger/g) ?? []).length, 2);
      assert.doesNotMatch(markup, /new-thread-context-separator|Workspace source|Run environment/);
      assert.equal(markup.includes('new-thread-context-branch'), !sandbox);
    } finally { scopes.dispose(); }
  }
});
