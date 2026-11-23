import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const read = (path) => readFileSync(join(root, path), "utf8");

test("one workflow releases every platform for a beta or a stable tag", () => {
  const release = read(".github/workflows/app-release.yml");
  for (const called of ["macos-universal-release", "android-release-apk", "ios-testflight", "ios-unsigned-ipa", "server-release"]) {
    assert.match(release, new RegExp(`uses: \\./\\.github/workflows/${called}\\.yml`, "u"), called);
  }
  // The tag must name the product version; a stable tag needs its notes.
  assert.match(release, /node scripts\/release\/product-version\.mjs check "\$TAG"/u);
  assert.match(release, /secure_release\.py changelog \\\n\s+--tag "\$TAG" --changelog CHANGELOG\.md/u);
  // Only stable releases run the performance gate, and staging waits for it.
  assert.match(release, /performance:\n {4}needs: tag\n {4}if: needs\.tag\.outputs\.prerelease == 'false'\n {4}uses: \.\/\.github\/workflows\/performance\.yml/u);
  assert.match(
    release,
    /candidate:\n {4}needs: \[tag, linux, windows, macos, android, ios_testflight, ios_unsigned, server, performance\]\n[^\n]*\n {4}if: \$\{\{ !cancelled\(\) && !failure\(\) \}\}/u,
  );
  assert.match(
    release,
    /publish:\n {4}needs: \[candidate, ios_testflight, container\]\n {4}if: \$\{\{ !cancelled\(\) && !failure\(\) && inputs\.publish \}\}/u,
  );
  // The tested server image is pushed, with its own write scope, before the release appears.
  const container = release.split("\n  container:\n")[1]?.split("\n\n  ")[0] ?? "";
  assert.match(container, /^ {4}needs: candidate\n {4}if: \$\{\{ !cancelled\(\) && !failure\(\) && inputs\.publish \}\}/u);
  assert.match(container, /packages: write/u);
  assert.match(container, /run: bash scripts\/release\/publish-container-release\.sh "\$TAG"/u);
  assert.doesNotMatch(release.split("\n  container:\n")[0], /packages: write/u, "only the container job can write packages");
  assert.match(release, /SERVER_IMAGE: \$\{\{ needs\.container\.outputs\.image \}\}/u);
  assert.match(release, /name: opencraft-ios-unsigned-\$\{\{ github\.sha \}\}/u);
  assert.match(release, /name: opencraft-android-release-\$\{\{ github\.sha \}\}/u);
  assert.match(release, /TESTFLIGHT_NUMBER: \$\{\{ needs\.ios_testflight\.outputs\.number \}\}/u);
  // There is no other release publisher.
  assert.throws(() => read(".github/workflows/release.yml"), /ENOENT/u);
});

// A checkout with one built input per platform for `tag`, staged and published
// by the real scripts against a stand-in gh that keeps the notes of the release
// it is asked to create and stops there.
function releaseFixture(t, tag, { changelog = "# Changelog\n" } = {}) {
  const version = tag.replace(/^v/u, "").replace(/-beta\.\d+$/u, "");
  const directory = mkdtempSync(join(tmpdir(), "opencraft-app-release-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const put = (path, content) => {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), content);
  };
  const kit = ".github/secure-release/v1/secure_release.py";
  mkdirSync(dirname(join(directory, kit)), { recursive: true });
  copyFileSync(join(root, kit), join(directory, kit));
  put("CHANGELOG.md", changelog);
  const git = (...args) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { cwd: directory });
  git("init", "--quiet");
  git("add", ".");
  git("commit", "--quiet", "-m", "fixture");
  git("remote", "add", "origin", directory);
  const commit = git("rev-parse", "HEAD").toString().trim();
  const digest = (path) => execFileSync("sha256sum", [path], { cwd: directory }).toString().split(" ")[0];

  const dmg = `OpenCraft-${version}-universal.dmg`;
  put(`inputs/macos/${dmg}`, "dmg");
  put(`inputs/macos/OpenCraft-${version}-mac-universal.zip`, "zip");
  execFileSync("bash", ["-c", "sha256sum OpenCraft-*-universal.dmg OpenCraft-*-mac-universal.zip > SHA256SUMS"], {
    cwd: join(directory, "inputs/macos"),
  });
  put(
    "inputs/macos/macos-universal-smoke.json",
    JSON.stringify({
      passed: true,
      hostRoundTrip: true,
      sourceRevision: commit,
      image: dmg,
      sha256: digest(`inputs/macos/${dmg}`),
    }),
  );
  put(`inputs/desktop/desktop-linux-x64/OpenCraft-${version}-linux-x86_64.AppImage`, "appimage");
  put(`inputs/desktop/desktop-windows-x64/OpenCraft-${version}-win-x64.zip`, "winzip");
  put(`inputs/desktop/desktop-windows-x64/OpenCraft-Setup-${version}-x64.exe`, "exe");
  const apk = "inputs/android/OpenCraft-app.opencraft-android-release.apk";
  const ipa = "inputs/ios/OpenCraft-ios-unsigned.ipa";
  put(apk, "apk");
  put(ipa, "ipa");
  const record = (path, value = digest(path)) => put(`${path}.sha256`, `${value}  release/${path.split("/").at(-1)}\n`);
  record(apk);
  record(ipa);
  const server = `inputs/server/OpenCraft-server-${version}-linux-amd64.tar.gz`;
  put(server, "server");
  record(server);

  const bin = join(directory, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "gh"),
    [
      "#!/usr/bin/env bash",
      'echo "$*" >> "$GH_LOG"',
      'if [[ "$1 $2" == "release create" ]]; then',
      '  while (( $# )); do if [[ "$1" == --notes-file ]]; then cp "$2" "$GH_NOTES"; fi; shift; done',
      "fi",
      "exit 1",
    ].join("\n"),
    { mode: 0o755 },
  );
  const run = (script, env = {}) =>
    spawnSync("bash", [join(root, `scripts/release/${script}`), tag], {
      cwd: directory,
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...env },
    });
  const publish = (testflight) => {
    rmSync(join(directory, "gh.log"), { force: true });
    rmSync(join(directory, "notes.md"), { force: true });
    const result = run("publish-app-release.sh", {
      GH_LOG: join(directory, "gh.log"),
      GH_NOTES: join(directory, "notes.md"),
      RUN_URL: "https://example.invalid/run",
      ...testflight,
    });
    const read = (name) => {
      try {
        return readFileSync(join(directory, name), "utf8");
      } catch {
        return null;
      }
    };
    return { status: result.status, gh: read("gh.log"), notes: read("notes.md") };
  };
  return { directory, apk, ipa, server, digest, record, stage: () => run("stage-app-release.sh"), publish };
}

const image = `ghcr.io/opencraft-app/opencraft-server@sha256:${"a".repeat(64)}`;
const build = { TESTFLIGHT_VERSION: "0.2.0", TESTFLIGHT_NUMBER: "7", SERVER_IMAGE: image };

test("staging binds every input to its recorded digest before moving anything", (t) => {
  const fixture = releaseFixture(t, "v0.2.0-beta.3");
  const wrong = "0".repeat(64);
  for (const path of [fixture.apk, fixture.ipa, fixture.server]) {
    fixture.record(path, wrong);
    assert.notEqual(fixture.stage().status, 0, `${path}: a digest mismatch must stop staging`);
    assert.throws(() => readdirSync(join(fixture.directory, "candidate")), /ENOENT/u, "nothing is staged");
    fixture.record(path);
  }
  const result = fixture.stage();
  assert.equal(result.status, 0, result.stderr);
  const manifest = JSON.parse(readFileSync(join(fixture.directory, "candidate/release-manifest.json"), "utf8"));
  assert.equal(manifest.tag, "v0.2.0-beta.3");
  assert.deepEqual(manifest.artifacts.map((artifact) => artifact.name).sort(), [
    "OpenCraft-0.2.0-beta.3-android-arm64.apk",
    "OpenCraft-0.2.0-beta.3-ios-unsigned.ipa",
    "OpenCraft-0.2.0-beta.3-linux-x86_64.AppImage",
    "OpenCraft-0.2.0-beta.3-mac-universal.zip",
    "OpenCraft-0.2.0-beta.3-universal.dmg",
    "OpenCraft-0.2.0-beta.3-win-x64.zip",
    "OpenCraft-Setup-0.2.0-beta.3-x64.exe",
    "OpenCraft-server-0.2.0-beta.3-linux-amd64.tar.gz",
    "SHA256SUMS.txt",
    "macos-universal-smoke.json",
  ]);
  assert.deepEqual(
    manifest.artifacts.find((artifact) => artifact.name === "OpenCraft-0.2.0-beta.3-ios-unsigned.ipa"),
    {
      name: "OpenCraft-0.2.0-beta.3-ios-unsigned.ipa",
      sha256: fixture.digest("candidate/OpenCraft-0.2.0-beta.3-ios-unsigned.ipa"),
      size: 3,
    },
  );
});

test("a beta is published as a pre-release naming the uploaded TestFlight build", (t) => {
  const fixture = releaseFixture(t, "v0.2.0-beta.3");
  assert.equal(fixture.stage().status, 0);
  for (const invalid of [
    {},
    { ...build, TESTFLIGHT_NUMBER: "0" },
    { ...build, TESTFLIGHT_PUBLIC_LINK: "https://example.com/join/abc" },
    { ...build, SERVER_IMAGE: undefined },
    { ...build, SERVER_IMAGE: "ghcr.io/opencraft-app/opencraft@sha256:" + "a".repeat(64) },
    { ...build, SERVER_IMAGE: "ghcr.io/opencraft-app/opencraft-server:latest" },
  ]) {
    const result = fixture.publish(invalid);
    assert.notEqual(result.status, 0, JSON.stringify(invalid));
    assert.equal(result.gh, null, "no GitHub call without a valid build");
  }
  const linked = fixture.publish({ ...build, TESTFLIGHT_PUBLIC_LINK: "https://testflight.apple.com/join/AbC123" });
  assert.match(linked.gh, /release create v0\.2\.0-beta\.3 --target [0-9a-f]{40} --draft --prerelease /u);
  assert.match(linked.notes, /^OpenCraft v0\.2\.0-beta\.3 from commit/u);
  assert.match(linked.notes, /\[TestFlight build 0\.2\.0 \(7\)\]\(https:\/\/testflight\.apple\.com\/join\/AbC123\)/u);
  assert.match(linked.notes, /iOS unsigned IPA is for signing with your own Apple ID/u);
  assert.ok(
    linked.notes.includes(`container image \`ghcr.io/opencraft-app/opencraft-server:0.2.0-beta.3\` (linux/amd64), pinned as \`${image}\``),
    linked.notes,
  );
  assert.match(fixture.publish(build).notes, /- iOS: TestFlight build 0\.2\.0 \(7\); it appears/u);
});

test("a stable release is published as latest and opens with its changelog section", (t) => {
  const changelog =
    "# Changelog\n\n## Unreleased\n\n## v0.2.0\n\n- One version across every app.\n\n## v0.1.17\n\n- Older.\n";
  const fixture = releaseFixture(t, "v0.2.0", { changelog });
  const staged = fixture.stage();
  assert.equal(staged.status, 0, staged.stderr);
  const manifest = JSON.parse(readFileSync(join(fixture.directory, "candidate/release-manifest.json"), "utf8"));
  assert.equal(manifest.version, "0.2.0");
  assert.ok(manifest.artifacts.some((artifact) => artifact.name === "OpenCraft-0.2.0-android-arm64.apk"));

  const published = fixture.publish(build);
  assert.match(published.gh, /release create v0\.2\.0 --target [0-9a-f]{40} --draft --latest /u);
  assert.doesNotMatch(published.gh, /--prerelease/u);
  assert.match(published.notes, /^## v0\.2\.0\n\n- One version across every app\.\n\nOpenCraft v0\.2\.0 from commit/u);
  assert.doesNotMatch(published.notes, /v0\.1\.17|Older/u);
});

test("a stable release without its changelog section is never created", (t) => {
  const fixture = releaseFixture(t, "v0.2.0", { changelog: "# Changelog\n\n## Unreleased\n\n- Pending.\n" });
  assert.equal(fixture.stage().status, 0);
  const published = fixture.publish(build);
  assert.notEqual(published.status, 0);
  assert.equal(published.gh, null);
});
