import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { androidVersionCode } from "../../scripts/release/android-version-code.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const read = (path) => readFileSync(join(root, path), "utf8");

test("release tags map to versionCodes in release order", () => {
  const ordered = [
    "v0.1.0-beta.1",
    "v0.1.0-beta.2",
    "v0.1.0-beta.98",
    "v0.1.0",
    "v0.1.1-beta.1",
    "v0.2.0",
    "v1.0.0-beta.1",
    "v2099.99.99",
  ];
  const codes = ordered.map(androidVersionCode);
  assert.deepEqual(codes.slice(0, 4), [10_001, 10_002, 10_098, 10_099]);
  for (let i = 1; i < codes.length; i++)
    assert.ok(codes[i] > codes[i - 1], `${ordered[i]} must supersede ${ordered[i - 1]}`);
  assert.ok(codes.at(-1) <= 2_100_000_000);
  for (const tag of [
    "0.1.0",
    "v0.1.0-beta.0",
    "v0.1.0-beta.99",
    "v0.100.0",
    "v0.1.100",
    "v2100.0.0",
    "v0.1.0-rc.1",
    "",
    undefined,
  ]) {
    assert.throws(() => androidVersionCode(tag), undefined, String(tag));
  }
});

test("the Expo config applies only a valid release versionCode", (t) => {
  const require = createRequire(join(root, "apps/mobile/app.config.js"));
  const load = () => require("./app.config.js")({ config: structuredClone(require("./app.json").expo) });
  const previous = process.env.OPENCRAFT_ANDROID_VERSION_CODE;
  t.after(() => {
    if (previous === undefined) delete process.env.OPENCRAFT_ANDROID_VERSION_CODE;
    else process.env.OPENCRAFT_ANDROID_VERSION_CODE = previous;
  });
  delete process.env.OPENCRAFT_ANDROID_VERSION_CODE;
  assert.equal(load().android.versionCode, require("./app.json").expo.android.versionCode);
  process.env.OPENCRAFT_ANDROID_VERSION_CODE = String(androidVersionCode("v0.1.0-beta.7"));
  assert.equal(load().android.versionCode, 10_007);
  for (const invalid of ["0", "-1", "1.5", "2100000001", ""]) {
    process.env.OPENCRAFT_ANDROID_VERSION_CODE = invalid;
    assert.throws(load, /OPENCRAFT_ANDROID_VERSION_CODE/u, invalid);
  }
});

test("the pre-release publishes only the production-signed APK", () => {
  const android = read(".github/workflows/android-release-apk.yml");
  assert.match(android, /environment: android-release/u);
  assert.match(android, /^  workflow_dispatch:\n    inputs:\n      tag:/mu);
  assert.match(android, /github\.ref == 'refs\/heads\/main'/u);
  assert.match(android, /matrix:build -- expo-android-release-apk/u);
  assert.doesNotMatch(android, /expo-android-internal-apk/u);
  assert.match(android, /package-manager-cache: false/u);
  assert.match(android, /if: always\(\)\n\s+run: rm -rf "\$RUNNER_TEMP\/android-release-signing"/u);

  const prerelease = read(".github/workflows/desktop-prerelease.yml");
  assert.match(prerelease, /uses: \.\/\.github\/workflows\/android-release-apk\.yml/u);
  assert.match(prerelease, /needs: \[linux, windows, macos, android\]/u);
  assert.match(prerelease, /name: opencraft-android-release-\$\{\{ github\.sha \}\}/u);
  assert.match(read("scripts/release/publish-desktop-beta.sh"), /Android arm64 APK/u);
});

test("staging binds the APK digest and publishes it under the release name", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "opencraft-stage-beta-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const put = (path, content) => {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), content);
  };
  const kit = ".github/secure-release/v1/secure_release.py";
  mkdirSync(dirname(join(directory, kit)), { recursive: true });
  copyFileSync(join(root, kit), join(directory, kit));
  put("apps/desktop/package.json", JSON.stringify({ version: "0.1.0" }));
  const git = (...args) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { cwd: directory });
  git("init", "--quiet");
  git("add", ".");
  git("commit", "--quiet", "-m", "fixture");
  const commit = git("rev-parse", "HEAD").toString().trim();

  put("inputs/macos/OpenCraft-0.1.0-universal.dmg", "dmg");
  put("inputs/macos/OpenCraft-0.1.0-mac-universal.zip", "zip");
  execFileSync(
    "bash",
    ["-c", "sha256sum OpenCraft-0.1.0-universal.dmg OpenCraft-0.1.0-mac-universal.zip > SHA256SUMS"],
    { cwd: join(directory, "inputs/macos") },
  );
  const dmgDigest = execFileSync("sha256sum", ["inputs/macos/OpenCraft-0.1.0-universal.dmg"], { cwd: directory })
    .toString()
    .split(" ")[0];
  put(
    "inputs/macos/macos-universal-smoke.json",
    JSON.stringify({
      passed: true,
      hostRoundTrip: true,
      sourceRevision: commit,
      image: "OpenCraft-0.1.0-universal.dmg",
      sha256: dmgDigest,
    }),
  );
  put("inputs/desktop/desktop-linux-x64/OpenCraft-0.1.0-linux-x86_64.AppImage", "appimage");
  put("inputs/desktop/desktop-windows-x64/OpenCraft-0.1.0-win-x64.zip", "winzip");
  put("inputs/desktop/desktop-windows-x64/OpenCraft-Setup-0.1.0-x64.exe", "exe");
  const apk = "inputs/android/OpenCraft-app.opencraft-android-release.apk";
  put(apk, "apk");
  const stage = () =>
    spawnSync("bash", [join(root, "scripts/release/stage-desktop-beta.sh"), "v0.1.0-beta.3"], {
      cwd: directory,
      encoding: "utf8",
    });

  put(`${apk}.sha256`, `${"0".repeat(64)}  release/OpenCraft-app.opencraft-android-release.apk\n`);
  assert.notEqual(stage().status, 0, "a digest mismatch must stop staging");
  assert.throws(
    () => readdirSync(join(directory, "candidate")),
    /ENOENT/u,
    "nothing is staged before every input verifies",
  );

  const apkDigest = execFileSync("sha256sum", [apk], { cwd: directory }).toString().split(" ")[0];
  put(`${apk}.sha256`, `${apkDigest}  release/OpenCraft-app.opencraft-android-release.apk\n`);
  const result = stage();
  assert.equal(result.status, 0, result.stderr);
  assert.ok(readdirSync(join(directory, "candidate")).includes("OpenCraft-0.1.0-beta.3-android-arm64.apk"));
  const manifest = JSON.parse(readFileSync(join(directory, "candidate/desktop-release-manifest.json"), "utf8"));
  assert.deepEqual(
    manifest.artifacts.find((artifact) => artifact.name === "OpenCraft-0.1.0-beta.3-android-arm64.apk"),
    { name: "OpenCraft-0.1.0-beta.3-android-arm64.apk", sha256: apkDigest, size: 3 },
  );
});

test("signing provisioning generates or imports a usable key and never replaces a stored one", (t) => {
  const keytool = spawnSync("keytool", ["-help"], { encoding: "utf8" });
  if (keytool.error) return t.skip("keytool is not installed");
  const directory = mkdtempSync(join(tmpdir(), "opencraft-provision-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bin = join(directory, "bin");
  mkdirSync(bin);
  // Stand-in gh: records each call and its standard input, and answers the
  // listings from fixture state.
  writeFileSync(
    join(bin, "gh"),
    [
      "#!/usr/bin/env bash",
      'state="$GH_FIXTURE"',
      'if [[ "$1 $2" == "secret list" ]]; then cat "$state/existing" 2>/dev/null; exit 0; fi',
      'if [[ "$1 $2" == "secret set" ]]; then cat > "$state/secret-$3"; exit 0; fi',
      'if [[ "$*" == *deployment-branch-policies* && "$*" != *POST* ]]; then exit 0; fi',
      'cat > /dev/null; echo "$*" >> "$state/api"',
    ].join("\n"),
    { mode: 0o755 },
  );
  const state = join(directory, "state");
  mkdirSync(state);
  const provision = (target) =>
    spawnSync("bash", [join(root, "scripts/release/provision-android-signing.sh"), target, "owner/repo"], {
      cwd: directory,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GH_FIXTURE: state },
      encoding: "utf8",
    });

  const key = join(directory, "key");
  const result = provision(key);
  assert.equal(result.status, 0, result.stderr);
  const api = readFileSync(join(state, "api"), "utf8");
  assert.match(api, /--method PUT repos\/owner\/repo\/environments\/android-release/u);
  assert.match(api, /--method POST .*deployment-branch-policies -f name=main/u);
  const secret = (name) => readFileSync(join(state, `secret-${name}`), "utf8");
  assert.deepEqual(
    Buffer.from(secret("ANDROID_RELEASE_KEYSTORE_BASE64"), "base64"),
    readFileSync(join(key, "opencraft-release.p12")),
  );
  assert.equal(secret("ANDROID_RELEASE_KEYSTORE_PASSWORD"), readFileSync(join(key, "password.txt"), "utf8"));
  assert.equal(secret("ANDROID_RELEASE_KEY_ALIAS"), "opencraft-release");
  const listed = spawnSync(
    "keytool",
    [
      "-list",
      "-keystore",
      join(key, "opencraft-release.p12"),
      "-storetype",
      "PKCS12",
      "-storepass:file",
      join(key, "password.txt"),
      "-alias",
      "opencraft-release",
    ],
    { encoding: "utf8" },
  );
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(result.stdout, /Signing certificate SHA-256: [0-9A-F:]{95}/u);

  // An existing key directory is uploaded as is, never regenerated.
  const keystoreBytes = readFileSync(join(key, "opencraft-release.p12"));
  const imported = provision(key);
  assert.equal(imported.status, 0, imported.stderr);
  assert.deepEqual(readFileSync(join(key, "opencraft-release.p12")), keystoreBytes);
  assert.deepEqual(Buffer.from(secret("ANDROID_RELEASE_KEYSTORE_BASE64"), "base64"), keystoreBytes);
  mkdirSync(join(directory, "unrelated"));
  assert.notEqual(provision(join(directory, "unrelated")).status, 0, "a directory without the key is refused");
  writeFileSync(join(directory, "unrelated/opencraft-release.p12"), "not a keystore");
  writeFileSync(join(directory, "unrelated/password.txt"), "wrong");
  rmSync(join(state, "api"));
  assert.notEqual(provision(join(directory, "unrelated")).status, 0, "an unreadable key is refused");
  assert.throws(() => readFileSync(join(state, "api")), /ENOENT/u, "GitHub is untouched when the key does not open");
  writeFileSync(join(state, "existing"), "ANDROID_RELEASE_KEYSTORE_BASE64\n");
  const again = provision(join(directory, "second"));
  assert.notEqual(again.status, 0);
  assert.match(again.stderr, /refusing to replace/u);
  assert.throws(() => readdirSync(join(directory, "second")), /ENOENT/u);
  assert.notEqual(provision(join(root, "scratch-key")).status, 0, "keys never land inside a Git checkout");
});
