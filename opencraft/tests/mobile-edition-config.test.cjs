const assert = require('node:assert/strict');
const test = require('node:test');

const configure = require('../apps/workbench-expo/app.config.js');
const base = require('../apps/workbench-expo/app.json').expo;

function editionConfig(edition, platform) {
  const original = {
    OPENCRAFT_LIGHTVELA_EDITION: process.env.OPENCRAFT_LIGHTVELA_EDITION,
    OPENCRAFT_ANDROID_RELEASE: process.env.OPENCRAFT_ANDROID_RELEASE,
    OPENCRAFT_IOS_RELEASE: process.env.OPENCRAFT_IOS_RELEASE,
  };
  try {
    delete process.env.OPENCRAFT_LIGHTVELA_EDITION;
    delete process.env.OPENCRAFT_ANDROID_RELEASE;
    delete process.env.OPENCRAFT_IOS_RELEASE;
    if (edition) process.env.OPENCRAFT_LIGHTVELA_EDITION = edition;
    if (platform) process.env[platform === 'ios' ? 'OPENCRAFT_IOS_RELEASE' : 'OPENCRAFT_ANDROID_RELEASE'] = '1';
    return configure({ config: base });
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('Expo Go keeps the development identity and existing callback', () => {
  const config = editionConfig(null, null);
  assert.equal(config.android.package, 'dev.vela.workbench');
  assert.equal(config.ios.bundleIdentifier, 'dev.vela.workbench');
  assert.equal(config.extra.lightvelaRegion, 'intl');
  assert.equal(config.extra.lightvelaLoginRedirect, 'opencraft://auth/lightvela');
});

test('both release editions have separate install identities and callbacks', () => {
  for (const platform of ['android', 'ios']) {
    const cn = editionConfig('cn', platform);
    const intl = editionConfig('intl', platform);
    assert.equal(cn[platform][platform === 'ios' ? 'bundleIdentifier' : 'package'], platform === 'ios' ? 'ai.lightvela.vela' : 'com.tencent.vela');
    assert.equal(intl[platform][platform === 'ios' ? 'bundleIdentifier' : 'package'], platform === 'ios' ? 'ai.lightvela.vela.intl' : 'com.tencent.vela.intl');
    assert.equal(cn.scheme, 'opencraft');
    assert.equal(intl.scheme, 'opencraft-intl');
    assert.equal(cn.extra.lightvelaRegion, 'cn');
    assert.equal(intl.extra.lightvelaRegion, 'intl');
    assert.equal(cn.extra.lightvelaLoginRedirect, 'opencraft://auth/lightvela');
    assert.equal(intl.extra.lightvelaLoginRedirect, 'opencraft-intl://auth/lightvela');
  }
});
