import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { accountPage } from '../../plugins/local-account/src/page';
import { serverDocumentStyles } from '@opencraft/design-system/document.web';
import { typographyRole } from '@opencraft/design-system/typography';

test('account document uses shared theme and typography before Workbench and formats its requested locale', async () => {
  execFileSync(process.execPath, ['scripts/generate-document-tokens.mjs', '--check']);
  for (const [locale, title] of [['en-US', 'Accounts and members'], ['zh-CN', '账号与成员']]) {
    const page = await accountPage({ nonce: 'synthetic', native: true, setup: false, locale });
    assert(page.includes('href="/__opencraft_account/styles.css"'));
    assert(page.includes(`<h1>${title}</h1>`));
    assert(page.includes('class="document-card document-row"'));
    assert(page.includes('id="password-section" hidden><details>'));
    assert(!page.includes('一个 Human'));
    assert(!page.includes('font:16px/1.6 system-ui'));
    new vm.Script(page.match(/<script nonce="synthetic">([\s\S]*?)<\/script>/)![1]);
  }
  const heading = typographyRole('settingsTitle', 'web');
  assert(serverDocumentStyles.includes(`${heading.fontSize}px/${heading.lineHeight}px`));
});

test('unauthenticated account document has no identity snapshot and no native connect action', async () => {
  const page = await accountPage({ nonce: 'synthetic', native: false, setup: true });
  assert(!page.includes('id="connect-form"'));
  assert(!page.includes('Local user'));
  assert(page.includes('id="identity" hidden'));
  assert(page.includes('id="administration" hidden'));
  assert(!page.includes('navigator.language'));
});
