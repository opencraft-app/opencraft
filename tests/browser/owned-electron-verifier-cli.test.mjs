import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, chmod, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

const cli = resolve("scripts/build/verify-owned-electron-artifact.mjs");
const hash = (data) => createHash("sha256").update(data).digest("hex");
const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });

test(
  "browser verifier CLI accepts exact inventory and rejects a changed executable",
  { skip: process.platform !== "linux" || process.arch !== "x64" },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "owned-cli-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const distribution = join(root, "distribution"),
      fork = join(root, "fork.json");
    await mkdir(distribution);
    const definition = JSON.stringify({ version: "44.8.0", chromiumVersion: "152.0.7977.167" });
    await writeFile(fork, definition);
    const files = [];
    for (const name of ["electron", "chrome-sandbox", "LICENSE", "LICENSES.chromium.html"]) {
      const bytes = Buffer.from("fixture " + name);
      await writeFile(join(distribution, name), bytes);
      files.push({ path: name, sha256: hash(bytes), size: bytes.length });
    }
    await chmod(join(distribution, "electron"), 0o755);
    await writeFile(
      join(distribution, "opencraft-electron-artifact.json"),
      JSON.stringify({
        schemaVersion: 1,
        platform: "linux",
        arch: process.arch,
        forkDefinitionSha256: hash(definition),
        electronVersion: "44.8.0",
        chromiumVersion: "152.0.7977.167",
        nativeCopyProbePassed: true,
        nativeInputCausalityProbePassed: true,
        nativeImeFocusIdentityProbePassed: true,
        files,
      }),
    );
    assert.equal(run("browser", "linux-x64", distribution, fork).status, 0);
    // Synthetic verifier fixture only; never real native probe acceptance.
    const markerPath = join(distribution, "opencraft-electron-artifact.json");
    const marker = JSON.parse(await readFile(markerPath, "utf8"));
    for (const flag of ["nativeCopyProbePassed", "nativeInputCausalityProbePassed", "nativeImeFocusIdentityProbePassed"]) {
      await writeFile(markerPath, JSON.stringify({...marker, [flag]: false}));
      const refused = run("browser", "linux-x64", distribution, fork);
      assert.notEqual(refused.status, 0, `${flag} is mandatory`);
      assert.match(refused.stderr, /all native input probes are required/);
    }
    await writeFile(markerPath, JSON.stringify(marker));
    await writeFile(join(distribution, "electron"), "tampered");
    const invalid = run("browser", "linux-x64", distribution, fork);
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /checksum/);
  },
);

test("desktop verifier CLI and target validation fail closed on invalid inputs", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "owned-cli-invalid-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.notEqual(run("desktop", "macos-arm64", root, join(root, "missing.json")).status, 0);
  assert.notEqual(run("browser", "macos-arm64", root, join(root, "missing.json")).status, 0);
  assert.notEqual(run("other", "linux-x64", root, join(root, "missing.json")).status, 0);
});

test("desktop verifier CLI verifies inventory and rejects tampered native bytes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "owned-desktop-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const distribution = join(root, "distribution"),
    fork = join(root, "fork.json");
  await mkdir(distribution);
  const definition = JSON.stringify({ version: "44.8.0", chromiumVersion: "152.0.7977.167" });
  await writeFile(fork, definition);
  const bytes = Buffer.from("desktop fixture");
  await writeFile(join(distribution, "electron"), bytes);
  await writeFile(
    join(distribution, "opencraft-electron-desktop-artifact.json"),
    JSON.stringify({
      schemaVersion: 1,
      platform: "linux",
      arch: "x64",
      forkDefinitionSha256: hash(definition),
      electronVersion: "44.8.0",
      chromiumVersion: "152.0.7977.167",
      nativeProbePassed: true,
      executable: "electron",
      executableSha256: hash(bytes),
      files: [{ path: "electron", type: "file", size: bytes.length, sha256: hash(bytes) }],
    }),
  );
  assert.equal(run("desktop", "linux-x64", distribution, fork).status, 0);
  await writeFile(join(distribution, "electron"), "tampered");
  const invalid = run("desktop", "linux-x64", distribution, fork);
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /inventory mismatch/);
});

test(
  "restored browser archive must match its evidence before it is usable",
  { skip: process.platform !== "linux" || process.arch !== "x64" },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "owned-restore-e2e-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const evidence = join(root, "evidence"),
      distribution = join(root, "restored"),
      fork = join(root, "fork.json");
    await mkdir(evidence);
    const definition = JSON.stringify({ version: "44.8.0", chromiumVersion: "152.0.7977.167" });
    await writeFile(fork, definition);
    const files = ["electron", "chrome-sandbox", "LICENSE", "LICENSES.chromium.html"].map((name) => {
      const bytes = Buffer.from("fixture " + name);
      return { path: name, sha256: hash(bytes), size: bytes.length };
    });
    await writeFile(
      join(evidence, "opencraft-electron-artifact.json"),
      JSON.stringify({
        schemaVersion: 1,
        platform: "linux",
        arch: "x64",
        forkDefinitionSha256: hash(definition),
        electronVersion: "44.8.0",
        chromiumVersion: "152.0.7977.167",
        nativeCopyProbePassed: true,
        nativeInputCausalityProbePassed: true,
        nativeImeFocusIdentityProbePassed: true,
        files,
      }),
    );
    const zip = spawnSync(
      "python3",
      [
        "-c",
        `import stat,sys,zipfile
with zipfile.ZipFile(sys.argv[1], 'w') as z:
 for name in ('electron','chrome-sandbox','LICENSE','LICENSES.chromium.html'):
  item=zipfile.ZipInfo(name);item.create_system=3;item.external_attr=(stat.S_IFREG | 0o755) << 16
  z.writestr(item, 'fixture '+name)
`,
        join(evidence, "dist.zip"),
      ],
      { encoding: "utf8" },
    );
    assert.equal(zip.status, 0, zip.stderr);
    const restore = spawnSync(
      "python3",
      ["vendor/electron/restore-artifact.py", "--directory", root, "--distribution", distribution, "--kind", "browser"],
      { encoding: "utf8" },
    );
    assert.equal(restore.status, 0, restore.stderr);
    assert.equal(run("browser", "linux-x64", distribution, fork).status, 0);
    await writeFile(join(distribution, "electron"), "tampered");
    assert.notEqual(run("browser", "linux-x64", distribution, fork).status, 0);
  },
);

test(
  "composite restore step exports a path only after successful verification",
  { skip: process.platform !== "linux" || process.arch !== "x64" },
  async (t) => {
    const { readFile } = await import("node:fs/promises");
    const root = await mkdtemp(join(tmpdir(), "owned-action-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const yaml = await readFile(".github/actions/owned-electron/action.yml", "utf8");
    const match = yaml.match(/    - id: paths\n[\s\S]*?      run: \|\n((?:        .*\n)+)/);
    assert.ok(match, "restore step is present");
    const script = match[1].replace(/^        /gm, "");
    const definition = await readFile("vendor/electron/fork.json");
    const fork = JSON.parse(definition);
    for (const tampered of [false, true]) {
      const dir = join(root, tampered ? "bad" : "good");
      const evidence = join(dir, "owned-electron-download-browser-linux-x64");
      await mkdir(evidence, { recursive: true });
      const files = ["electron", "chrome-sandbox", "LICENSE", "LICENSES.chromium.html"].map((name) => {
        const bytes = Buffer.from("fixture " + name);
        return { path: name, sha256: hash(bytes), size: bytes.length };
      });
      await writeFile(
        join(evidence, "opencraft-electron-artifact.json"),
        JSON.stringify({
          schemaVersion: 1,
          platform: "linux",
          arch: "x64",
          forkDefinitionSha256: hash(definition),
          electronVersion: fork.version,
          chromiumVersion: fork.chromiumVersion,
          nativeCopyProbePassed: true,
        nativeInputCausalityProbePassed: true,
        nativeImeFocusIdentityProbePassed: true,
          files,
        }),
      );
      const zip = spawnSync(
        "python3",
        [
          "-c",
          `import stat,sys,zipfile
with zipfile.ZipFile(sys.argv[1], 'w') as z:
 for name in ('electron','chrome-sandbox','LICENSE','LICENSES.chromium.html'):
  item=zipfile.ZipInfo(name);item.create_system=3;item.external_attr=(stat.S_IFREG | 0o755) << 16
  z.writestr(item, ('tampered' if name == 'electron' and sys.argv[2] == 'yes' else 'fixture '+name))
`,
          join(evidence, "dist.zip"),
          tampered ? "yes" : "no",
        ],
        { encoding: "utf8" },
      );
      assert.equal(zip.status, 0, zip.stderr);
      const envFile = join(dir, "github-env"),
        outputFile = join(dir, "github-output");
      await writeFile(envFile, "");
      await writeFile(outputFile, "");
      const result = spawnSync("bash", ["-eo", "pipefail", "-c", script], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${join(process.execPath, "..")}\u003a${process.env.PATH}`,
          RUNNER_TEMP: dir,
          ARTIFACT_KIND: "browser",
          ARTIFACT_TARGET: "linux-x64",
          GITHUB_ENV: envFile,
          GITHUB_OUTPUT: outputFile,
        },
      });
      if (tampered) {
        assert.notEqual(result.status, 0);
        assert.equal(await readFile(envFile, "utf8"), "");
        assert.equal(await readFile(outputFile, "utf8"), "");
      } else {
        assert.equal(result.status, 0, result.stderr);
        assert.match(await readFile(envFile, "utf8"), /OPENCRAFT_BROWSER_ELECTRON_DISTRIBUTION=/);
        assert.match(await readFile(outputFile, "utf8"), /distribution=/);
      }
    }
  },
);
