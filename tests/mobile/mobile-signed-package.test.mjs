import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

const expoRoot = resolve(import.meta.dirname, "../../apps/mobile");
const require = createRequire(import.meta.url);
const configureExpo = require(join(expoRoot, "app.config.js"));

const publicNotice = require("../../packages/react-runtime/NOTICE.json");

const withBuildInputs = ({ android = false, ios = false, testflight = false, buildNumber = "1" }, run) => {
  const inputs = {
    OPENCRAFT_ANDROID_RELEASE: android ? "1" : undefined,
    OPENCRAFT_IOS_RELEASE: ios ? "1" : undefined,
    OPENCRAFT_IOS_EXPORT_METHOD: testflight ? "app-store-connect" : undefined,
    OPENCRAFT_IOS_BUILD_NUMBER: testflight ? buildNumber : undefined,
    APPLE_TEAM_ID: testflight ? "ABCDE12345" : undefined,
  };
  const saved = Object.fromEntries(Object.keys(inputs).map(key => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(inputs)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

const standaloneConfig = () => ({
  name: "OpenCraft",
  android: { package: "dev.opencraft.workbench", versionCode: 1 },
  ios: { bundleIdentifier: "dev.opencraft.workbench", supportsTablet: true },
  extra: { fixture: "preserved", openSourceNotices: [{ name: "Fixture dependency", license: "MIT" }] },
});

const assertNotices = (actual, base) => {
  assert.deepEqual(actual.extra.openSourceNotices, [...base.extra.openSourceNotices, publicNotice]);
  assert.equal(actual.extra.fixture, "preserved");
};

test("mobile identities ignore release flags and retain license notices", () => {
  const base = standaloneConfig();
  const original = structuredClone(base);
  for (const android of [false, true]) {
    for (const ios of [false, true]) {
      const result = withBuildInputs({ android, ios }, () => configureExpo({ config: base }));
      assert.equal(result.name, "OpenCraft");
      assert.deepEqual(result.android, original.android);
      assert.deepEqual(result.ios, original.ios);
      assertNotices(result, original);
      assert.deepEqual(base, original, "building must not mutate the input manifest");
    }
  }
});

test("the TestFlight profile resolves the production iOS identity and selected build number", () => {
  const base = standaloneConfig();
  const config = withBuildInputs({ ios: true, testflight: true, buildNumber: "42" }, () => configureExpo({ config: base }));
  assert.deepEqual(config.ios, { ...base.ios, bundleIdentifier: "app.opencraft", buildNumber: "42" });
  assert.deepEqual(config.android, base.android);
  assertNotices(config, base);
  assert.throws(() => withBuildInputs({ testflight: true, buildNumber: "1;invalid" }, () => configureExpo({ config: base })), /OPENCRAFT_IOS_BUILD_NUMBER/);
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
    module.DOWNLOAD_PATH = "/release.apk"
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
