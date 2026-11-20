const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');
const semver = require('semver');

const app = path.resolve(__dirname, '../../apps/mobile');

// The public app is a WebView container. Native modules here are compiled into
// every build, so only modules the container itself uses belong in it.
const CONTAINER_NATIVE_MODULES = [
  'expo', 'expo-asset', 'expo-clipboard', 'expo-constants', 'expo-crypto', 'expo-file-system',
  'expo-glass-effect', 'expo-secure-store', 'expo-sqlite', 'expo-status-bar',
  'react-native', 'react-native-safe-area-context', 'react-native-svg', 'react-native-webview',
];

test('the public container declares only the native modules it uses, at the installed SDK versions', () => {
  const fromApp = createRequire(path.join(app, 'package.json'));
  const manifest = fromApp('./package.json');
  const bundled = JSON.parse(fs.readFileSync(path.join(path.dirname(fromApp.resolve('expo/package.json')), 'bundledNativeModules.json'), 'utf8'));
  const native = Object.keys(manifest.dependencies).filter(name => /^(expo(-|$)|react-native(-|$)|@expo\/)/u.test(name) && !['react-native-web', '@expo/metro-runtime'].includes(name));
  assert.deepEqual(native.sort(), [...CONTAINER_NATIVE_MODULES].sort());
  for (const name of native) {
    if (!bundled[name]) continue;
    const installed = JSON.parse(fs.readFileSync(fromApp.resolve(`${name}/package.json`), 'utf8'));
    assert.ok(semver.satisfies(installed.version, manifest.dependencies[name]), `${name} must satisfy its direct declaration`);
  }
});

test('standalone Expo config keeps the public identity and requests no unused permissions', () => {
  const config = require(path.join(app, 'app.config.js'))({ config: require(path.join(app, 'app.json')).expo });
  assert.equal(config.name, 'OpenCraft');
  assert.equal(config.scheme, 'opencraft');
  // Retain legacy IDs; changing an installed app's identity is a separate decision.
  assert.equal(config.ios.bundleIdentifier, 'dev.opencraft.workbench');
  assert.equal(config.android.package, 'dev.opencraft.workbench');
  // Secure storage holds settings, not biometric-gated secrets: no Face ID prompt.
  assert.deepEqual(config.plugins, ['expo-sqlite', ['expo-secure-store', { faceIDPermission: false }]]);
  assert.equal(config.icon, './assets/icon.png');
  // The container asks for no camera, photo or microphone access.
  assert.deepEqual(Object.keys(config.ios.infoPlist ?? {}).filter(key => key.endsWith('UsageDescription')), []);
  assert.deepEqual(config.android.permissions ?? [], []);
});

// Real public shell entry with only native SDK/Expo subprocesses replaced.
// Stop before generating a native project, signing or invoking Gradle/Xcode.
function capturePrebuild(script, release) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'opencraft-native-build-'));
  try {
    // Standalone source fixture without a generated native project.
    const standalone = path.join(temp, 'apps/mobile');
    fs.mkdirSync(path.join(standalone, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(temp, 'packages/react-runtime'), { recursive: true });
    fs.copyFileSync(path.join(app, '../../packages/react-runtime/NOTICE.json'), path.join(temp, 'packages/react-runtime/NOTICE.json'));
    for (const name of ['app.json', 'app.config.js']) fs.copyFileSync(path.join(app, name), path.join(standalone, name));
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
  test(`${script} reaches the public prebuild`, { skip: process.platform === 'win32' }, () => {
    const selected = capturePrebuild(script, false);
    assert.deepEqual(selected.args, ['scripts/run-expo.cjs', 'prebuild', '--platform', platform, '--no-install', clean]);
    if (script === 'build-android-release-apk.sh') assert.equal(selected.release, '1');
  });
}

test('iOS release keeps a clean prebuild', { skip: process.platform === 'win32' }, () => {
  const selected = capturePrebuild('build-ios-ipa.sh', true);
  assert.equal(selected.args.at(-1), '--clean');
});
