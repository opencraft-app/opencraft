import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

test("a dev build runs on any branch and never touches release or signing channels", () => {
  const dev = read(".github/workflows/dev-build.yml");
  assert.match(dev, /^on:\n {2}workflow_dispatch:\n/mu);
  // Any branch: no main gate. Nothing to publish: read-only token, no secrets.
  assert.doesNotMatch(dev, /refs\/heads\/main/u);
  assert.doesNotMatch(dev, /secrets\.|environment:|contents: write|id-token/u);
  assert.doesNotMatch(dev, /\bgh release\b|\bgit tag\b|\baltool\b/u);
  for (const called of dev.matchAll(/uses: \.\/\.github\/workflows\/([\w-]+)\.yml/gu)) {
    assert.ok(["android-internal-apk", "ios-unsigned-ipa"].includes(called[1]), called[1]);
  }
  // Development identities only: the dev-key APK, the unsigned IPA and the macOS Preview app.
  assert.match(dev, /uses: \.\/\.github\/workflows\/android-internal-apk\.yml/u);
  assert.match(dev, /uses: \.\/\.github\/workflows\/ios-unsigned-ipa\.yml/u);
  assert.match(dev, /run: npm run package:mac:arm64:preview --workspace @opencraft\/desktop/u);
  assert.match(dev, /OPENCRAFT_BUILD_ID: dev-\$\{\{ github\.run_number \}\}-\$\{\{ github\.sha \}\}/u);
  for (const platform of ["linux-x64", "windows-x64", "macos-arm64"]) {
    assert.ok(dev.includes(`name: opencraft-dev-${platform}-\${{ github.sha }}`), platform);
  }
  assert.match(dev, /jq -e 'all\(\.\[\]; \.result == "success" or \.result == "skipped"\)'/u);
});

test("the development APK workflow is callable and still unrelated to the production key", () => {
  const internal = read(".github/workflows/android-internal-apk.yml");
  assert.match(internal, /^ {2}workflow_dispatch:\n {2}workflow_call:\n/mu);
  assert.match(internal, /matrix:build -- expo-android-internal-apk/u);
  assert.doesNotMatch(internal, /secrets\.|environment:|ANDROID_RELEASE/u);
  assert.match(internal, /name: opencraft-android-internal-\$\{\{ github\.sha \}\}/u);
});
