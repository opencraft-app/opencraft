import assert from 'node:assert/strict';
import test from 'node:test';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConnectorBrowser } from '../plugins/lightvela-hermes/src/connectors/connectors-settings-view';
import { connectorCatalog } from '../plugins/lightvela-hermes/src/connectors/catalog-snapshot';
import { initialConnectorSession } from '../plugins/lightvela-hermes/src/connectors/connector-session';
import { isConnectorVisible } from '../plugins/lightvela-hermes/src/connectors/connector-client';

test('WorkBuddy and browser OAuth connectors are excluded even when already configured on the Bot', () => {
  Object.assign(globalThis, { React });
  const hidden = connectorCatalog.filter(card => !isConnectorVisible(card));
  assert.equal(hidden.length, 15);
  for (const id of ['ima-mcp', 'tencent-docs', 'lexiang', 'tencent-docs-oa', 'canva', 'canva-ai', 'westock-mcp', 'flova', 'tencent-qidian-cs']) {
    assert.ok(hidden.some(card => card.id === id));
  }
  const publicCard = connectorCatalog.find(isConnectorVisible)!;
  const html = renderToStaticMarkup(createElement(ConnectorBrowser, {
    catalog: [...hidden, publicCard], canManage: true,
    session: { ...initialConnectorSession, phase: 'ready', instances: hidden.map(card => ({
      instanceId: card.id, packageId: card.id, displayName: card.name, defaultOpen: true,
    })) },
    onProbe() {}, onInstall() {}, onCancel() {}, onAuthorize() {}, onDisable() {},
  }));
  assert.equal((html.match(/class="hermes-connectors__card"/g) ?? []).length, 1);
  assert.match(html, /全部 1/);
  assert.match(html, /已配置 0/);
  assert.doesNotMatch(html, /需要 WorkBuddy 专属账号服务/);
});

test('catalogue and icons render before authentication, installation or probe completion', () => {
  // tsx's Node loader uses classic JSX for workspace-source dependencies.
  Object.assign(globalThis, { React });
  assert.equal(connectorCatalog.length, 173);
  for (const phase of ['idle', 'probing', 'missing', 'error'] as const) {
    for (const canManage of [false, true]) {
      const html = renderToStaticMarkup(createElement(ConnectorBrowser, {
        session: { ...initialConnectorSession, phase }, canManage,
        release: { url: 'https://example.com/release', sha256: 'a'.repeat(64) },
        onProbe() {}, onInstall() {}, onCancel() {}, onAuthorize() {}, onDisable() {},
      }));
      assert.match(html, /hermes-connectors__card/);
      assert.match(html, /loading="lazy"/);
      assert.match(html, /搜索连接器/);
      if (canManage) {
        const install = html.match(/<button[^>]*>安装运行服务<\/button>/)?.[0];
        assert.ok(install);
        assert.doesNotMatch(install, /disabled/);
        assert.match(html, /<details class="hermes-connectors__setup">/);
      }
    }
  }
});
