import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

const expoRoot = resolve(import.meta.dirname, "../apps/workbench-expo");
const require = createRequire(import.meta.url);
const configureExpo = require(join(expoRoot, "app.config.js"));

const withProfile = (android, ios, run) => {
  const beforeAndroid = process.env.OPENCRAFT_ANDROID_RELEASE;
  const beforeIos = process.env.OPENCRAFT_IOS_RELEASE;
  try {
    if (android) process.env.OPENCRAFT_ANDROID_RELEASE = "1";
    else delete process.env.OPENCRAFT_ANDROID_RELEASE;
    if (ios) process.env.OPENCRAFT_IOS_RELEASE = "1";
    else delete process.env.OPENCRAFT_IOS_RELEASE;
    return run();
  } finally {
    if (beforeAndroid === undefined) delete process.env.OPENCRAFT_ANDROID_RELEASE;
    else process.env.OPENCRAFT_ANDROID_RELEASE = beforeAndroid;
    if (beforeIos === undefined) delete process.env.OPENCRAFT_IOS_RELEASE;
    else process.env.OPENCRAFT_IOS_RELEASE = beforeIos;
  }
};

test("mobile package identities are opt-in and platform-specific", () => {
  const base = {
    name: "OpenCraft",
    android: { package: "dev.vela.workbench", versionCode: 1 },
    ios: { bundleIdentifier: "dev.vela.workbench", supportsTablet: true },
  };
  assert.equal(withProfile(false, false, () => configureExpo({ config: base })), base);

  const android = withProfile(true, false, () => configureExpo({ config: base }));
  assert.equal(android.name, "LightVela");
  assert.equal(android.android.package, "com.tencent.vela");
  assert.equal(android.ios.bundleIdentifier, "dev.vela.workbench");
  assert.equal(base.android.package, "dev.vela.workbench");

  const ios = withProfile(false, true, () => configureExpo({ config: base }));
  assert.equal(ios.name, "LightVela");
  assert.equal(ios.ios.bundleIdentifier, "ai.lightvela.vela");
  assert.equal(ios.android.package, "dev.vela.workbench");
});

test("release signing only replaces the generated Gradle release identity", () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "opencraft-signing-fixture-"));
  try {
    const script = join(fixtureRoot, "scripts/configure-android-release-signing.cjs");
    const gradle = join(fixtureRoot, "android/app/build.gradle");
    mkdirSync(dirname(script), { recursive: true });
    mkdirSync(dirname(gradle), { recursive: true });
    copyFileSync(join(expoRoot, "scripts/configure-android-release-signing.cjs"), script);
    writeFileSync(gradle, [
      "android {",
      "    signingConfigs {",
      "        debug {}",
      "    }",
      "    buildTypes {",
      "        debug {",
      "            signingConfig signingConfigs.debug",
      "        }",
      "        release {",
      "            signingConfig signingConfigs.debug",
      "        }",
      "    }",
      "}",
    ].join("\n"));

    const result = spawnSync(process.execPath, [script], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const output = readFileSync(gradle, "utf8");
    assert.match(output, /storeType 'pkcs12'/);
    assert.match(output, /signingConfig signingConfigs\.release/);
    assert.equal(output.match(/signingConfig signingConfigs\.debug/g)?.length, 1);
    assert.equal(spawnSync(process.execPath, [script]).status, 1, "repeat patching must fail closed");
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("temporary APK server exposes only the release package", () => {
  const script = join(expoRoot, "scripts/serve-android-release-apk.py");
  const python = `
import importlib.util
import tempfile
import threading
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

spec = importlib.util.spec_from_file_location("apk_server", ${JSON.stringify(script)})
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
with tempfile.TemporaryDirectory() as directory:
    module.APK = Path(directory) / "release.apk"
    module.APK.write_bytes(b"test-apk")
    server = ThreadingHTTPServer(("127.0.0.1", 0), module.ApkHandler)
    thread = threading.Thread(target=server.serve_forever)
    thread.start()
    try:
        base = f"http://127.0.0.1:{server.server_port}"
        with urlopen(base + module.DOWNLOAD_PATH) as response:
            assert response.read() == b"test-apk"
        with urlopen(Request(base + module.DOWNLOAD_PATH, method="HEAD")) as response:
            assert response.headers["Content-Length"] == "8"
        try:
            urlopen(base + "/release-filing.txt")
            raise AssertionError("unlisted path was served")
        except HTTPError as error:
            assert error.code == 404
    finally:
        server.shutdown()
        thread.join()
        server.server_close()
`;
  const result = spawnSync("python3", ["-c", python], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});
