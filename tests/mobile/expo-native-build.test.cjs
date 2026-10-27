const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');
const semver = require('semver');

const app = path.resolve(__dirname, '../../apps/mobile');

test('Expo Router and animation runtime resolve within the installed SDK contract', () => {
  const fromApp = createRequire(path.join(app, 'package.json'));
  const manifest = fromApp('./package.json');
  const sdkFile = fromApp.resolve('expo/package.json');
  const bundled = JSON.parse(fs.readFileSync(path.join(path.dirname(sdkFile), 'bundledNativeModules.json'), 'utf8'));
  const packages = {};
  for (const name of ['expo-router', 'react-native-reanimated', 'react-native-worklets']) {
    const file = fromApp.resolve(`${name}/package.json`);
    const installed = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.ok(semver.satisfies(installed.version, manifest.dependencies[name]), `${name} must satisfy its direct declaration`);
    assert.ok(semver.satisfies(installed.version, bundled[name]), `${name} must match the installed Expo SDK`);
    packages[name] = { file, installed };
  }
  const reanimated = packages['react-native-reanimated'];
  const worklets = packages['react-native-worklets'];
  const fromReanimated = createRequire(reanimated.file);
  assert.ok(semver.satisfies(worklets.installed.version, reanimated.installed.peerDependencies['react-native-worklets']), 'Worklets must satisfy Reanimated native compatibility');
  assert.equal(fs.realpathSync(fromReanimated.resolve('react-native-worklets/package.json')), fs.realpathSync(worklets.file), 'Expo and Reanimated must share one Worklets runtime');
  assert.equal(fs.realpathSync(fromApp.resolve('react-native-worklets/plugin')), fs.realpathSync(fromReanimated.resolve('react-native-worklets/plugin')), 'The Babel plugin must come from the same Worklets package');
  for (const name of ['@gorhom/bottom-sheet', 'heroui-native']) {
    const fromConsumer = createRequire(fromApp.resolve(`${name}/package.json`));
    assert.equal(fs.realpathSync(fromConsumer.resolve('react-native-reanimated/package.json')), fs.realpathSync(reanimated.file), `${name} must use the Expo Reanimated runtime`);
    assert.equal(fs.realpathSync(fromConsumer.resolve('react-native-worklets/package.json')), fs.realpathSync(worklets.file), `${name} must use the Expo Worklets runtime`);
  }
});

test('standalone Expo config keeps the public identity and permission wording', () => {
  const config = require(path.join(app, 'app.config.js'))({ config: require(path.join(app, 'app.json')).expo });
  assert.equal(config.name, 'OpenCraft');
  assert.equal(config.scheme, 'opencraft');
  // Retain legacy IDs; changing an installed app's identity is a separate decision.
  assert.equal(config.ios.bundleIdentifier, 'dev.opencraft.workbench');
  assert.equal(config.android.package, 'dev.opencraft.workbench');
  const commands = require(path.join(app, 'package.json')).scripts;
  assert.equal(Object.values(commands).some(command => /\bproducts[\\/]/u.test(command)), false, 'Public native commands must work without downstream product workspaces');
  assert.equal(config.plugins.find(p => p[0] === 'expo-image-picker')[1].photosPermission, 'Allow OpenCraft to choose a profile photo.');
  assert.equal(config.plugins.find(p => p[0] === 'expo-audio')[1].microphonePermission, 'Allow OpenCraft to record your voice for transcription.');
});

// Real public shell entry with only native SDK/Expo subprocesses replaced.
// Stop before generating a native project, signing or invoking Gradle/Xcode.
function capturePrebuild(script, release) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'opencraft-native-build-'));
  try {
    // Standalone source fixture has no downstream products sibling or native project.
    const standalone = path.join(temp, 'apps/mobile');
    fs.mkdirSync(path.join(standalone, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(temp, 'packages/react-runtime'), { recursive: true });
    fs.copyFileSync(path.join(app, '../../packages/react-runtime/NOTICE.json'), path.join(temp, 'packages/react-runtime/NOTICE.json'));
    for (const name of ['app.json', 'app.config.js', 'product-entry.cjs']) fs.copyFileSync(path.join(app, name), path.join(standalone, name));
    fs.copyFileSync(path.join(app, 'scripts', script), path.join(standalone, 'scripts', script));
    const bin = path.join(temp, 'bin'); fs.mkdirSync(bin);
    const result = path.join(temp, 'capture.json');
    const capture = path.join(temp, 'capture.cjs');
    fs.writeFileSync(capture, `
      const args = process.argv.slice(2);
      if (args[0] === '-e') {
        require('node:child_process').execFileSync(process.execPath, args, { stdio: 'inherit' });
      } else {
        require('node:fs').writeFileSync(process.env.NATIVE_TEST_RESULT, JSON.stringify({args,
          entry: process.env.OPENCRAFT_EXPO_PRODUCT_ENTRY ?? null,
          config: process.env.OPENCRAFT_EXPO_PRODUCT_CONFIG ?? null,
          cwd: process.cwd(), release: process.env.OPENCRAFT_ANDROID_RELEASE }));
        process.exitCode = 42;
      }
    `);
    fs.writeFileSync(path.join(bin, 'node'), `#!/bin/sh\nexec '${process.execPath}' '${capture}' "$@"\n`, { mode: 0o755 });
    for (const command of ['java', 'pod', 'xcodebuild', 'keytool', 'openssl', 'sha256sum', 'md5sum', 'base64']) fs.writeFileSync(path.join(bin, command), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'uname'), '#!/bin/sh\necho Darwin\n', { mode: 0o755 });
    const key = path.join(temp, 'fixture-key'); fs.writeFileSync(key, 'test placeholder, not a key');
    const env = { ...process.env, PATH: bin + path.delimiter + process.env.PATH,
      APPLE_TEAM_ID: 'fixture-team', ANDROID_HOME: temp, OPENCRAFT_IOS_RELEASE: release ? '1' : '0',
      OPENCRAFT_ANDROID_RELEASE_KEYSTORE: key, OPENCRAFT_ANDROID_RELEASE_PASSWORD_FILE: key,
      OPENCRAFT_ANDROID_RELEASE_KEY_ALIAS: 'fixture', NATIVE_TEST_RESULT: result };
    for (const name of ['OPENCRAFT_EXPO_PRODUCT_ENTRY', 'OPENCRAFT_EXPO_PRODUCT_CONFIG', 'OPENCRAFT_EXPO_ROUTER_CONTEXT_ENTRY', 'OPENCRAFT_EXPO_PRODUCT_STYLES']) delete env[name];
    const execution = spawnSync('bash', [path.join(standalone, 'scripts', script)], { env, encoding: 'utf8' });
    assert.equal(execution.status, 42, execution.stderr);
    const selected = JSON.parse(fs.readFileSync(result, 'utf8'));
    assert.equal(fs.realpathSync(selected.cwd), fs.realpathSync(standalone), 'prebuild runs in the same checkout across filesystem aliases');
    return selected;
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}

for (const [script, platform, clean] of [
  ['build-android-apk.sh', 'android', '--no-clean'],
  ['build-android-release-apk.sh', 'android', '--clean'],
  ['build-ios-ipa.sh', 'ios', '--no-clean'],
]) {
  test(`${script} reaches the public prebuild without a downstream checkout`, { skip: process.platform === 'win32' }, () => {
    const selected = capturePrebuild(script, false);
    assert.deepEqual(selected.args, ['scripts/run-expo.cjs', 'prebuild', '--platform', platform, '--no-install', clean]);
    assert.equal(selected.entry, null); assert.equal(selected.config, null);
    if (script === 'build-android-release-apk.sh') assert.equal(selected.release, '1');
  });
}

test('generic iOS release keeps clean prebuild without private edition selection', { skip: process.platform === 'win32' }, () => {
  const selected = capturePrebuild('build-ios-ipa.sh', true);
  assert.equal(selected.args.at(-1), '--clean');
  assert.equal(selected.entry, null); assert.equal(selected.config, null);
});
