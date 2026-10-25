const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const appRoot = path.resolve(__dirname, '../../apps/mobile');
const appRequire = createRequire(path.join(appRoot, 'package.json'));
const previousCwd = process.cwd();
process.chdir(appRoot);
const config = require('../../apps/mobile/metro.config.cjs');
process.chdir(previousCwd);
const nativePath = appRequire.resolve('react-native');
const assetRoot = path.dirname(appRequire.resolve('expo-asset/package.json'));
// Node does not enable Metro's react-native package export condition. Select
// the installed package's published native export at the filesystem boundary.
const uniwindRoot = path.dirname(appRequire.resolve('uniwind/package.json'));
const nativeUiPath = path.resolve(uniwindRoot, appRequire('uniwind/package.json').exports['./components']['react-native']);
const resolveRequest = (_context, name) => ({ type: 'sourceFile', filePath: name === 'uniwind/components' ? nativeUiPath : appRequire.resolve(name) });

// Use the installed Expo/Uniwind resolver chain, with filesystem package lookup
// supplied at Metro's boundary. Do not replace the dependency's component facade.
for (const platform of ['ios', 'android']) {
  test(`${platform} Expo assets and generated asset modules share RN's actual registry`, () => {
    for (const relative of ['src/Asset.ts', 'src/resolveAssetSource.ts']) {
      const result = config.resolver.resolveRequest({ originModulePath: path.join(assetRoot, relative), resolveRequest }, 'react-native', platform);
      assert.equal(result.filePath, nativePath);
    }
    const cache = new Map();
    const babel = appRequire('@babel/core');
    const nativeRoot = path.dirname(nativePath);
    // Evaluate published RN's Flow source so this regression exercises the
    // real public getter and generated-module entry, without a native device.
    function load(filename) {
      if (cache.has(filename)) return cache.get(filename).exports;
      const module = { exports: {} }; cache.set(filename, module);
      const source = babel.transformSync(fs.readFileSync(filename, 'utf8'), {
        filename, configFile: false, babelrc: false,
        presets: [[appRequire.resolve('babel-preset-expo'), {}]],
        caller: { name: 'metro', platform, supportsStaticESM: false, isDev: false },
      }).code;
      const localRequire = createRequire(filename);
      const requireNative = name => {
        const target = localRequire.resolve(name);
        return target.startsWith(nativeRoot + path.sep) && target.endsWith('.js') ? load(target) : localRequire(name);
      };
      vm.runInNewContext(`(function(require,module,exports){${source}\n})`, { __DEV__: false, console, process }, { filename })(requireNative, module, module.exports);
      return module.exports;
    }
    const registry = load(nativePath).AssetRegistry;
    const assetEntry = load(appRequire.resolve(config.transformer.assetRegistryPath));
    const metadata = { __packager_asset: true, name: 'mobile-workbench', type: 'html', scales: [1], hash: 'fixture' };
    const id = assetEntry.registerAsset(metadata);
    assert.equal(registry.getAssetByID(id), metadata);
    assert.equal(assetEntry.getAssetByID(id), metadata);
  });
}

test('native UI still receives the existing Uniwind component facade', () => {
  const result = config.resolver.resolveRequest({ originModulePath: path.join(appRoot, 'src/components/workspace-surface.native.tsx'), resolveRequest }, 'react-native', 'ios');
  assert.equal(result.filePath, nativeUiPath);
});
