import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../../scripts/release/publish-container-release.sh", import.meta.url));
const tested = `sha256:${"1".repeat(64)}`;
const digest = `sha256:${"2".repeat(64)}`;

// Runs the real publisher against a stand-in docker that records every call.
// PUBLISHED: whether the version tag already exists; PULLED_ID: the image the
// registry serves back; REVISION: the commit label of the loaded image.
function publish(t, tag, env = {}) {
  const directory = mkdtempSync(join(tmpdir(), "opencraft-container-release-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { cwd: directory })
      .toString()
      .trim();
  git("init", "--quiet");
  git("commit", "--quiet", "--allow-empty", "-m", "fixture");
  const commit = git("rev-parse", "HEAD");
  const log = join(directory, "docker.log");
  writeFileSync(
    join(directory, "docker"),
    `#!/usr/bin/env bash
echo "$*" >> "$DOCKER_LOG"
case "$*" in
  "login "*) cat >/dev/null;;
  "image inspect opencraft:local --format {{.Id}}") echo "${tested}";;
  *"--format {{.Architecture}}") echo amd64;;
  *"org.opencontainers.image.revision"*) echo "\${REVISION:-$COMMIT}";;
  "buildx imagetools inspect "*) if [[ "\${PUBLISHED:-no}" == yes ]]; then echo ok; else echo "manifest unknown" >&2; exit 1; fi;;
  *":"*" --format {{.Id}}") echo "\${PULLED_ID:-${tested}}";;
  *"--format {{index .RepoDigests 0}}") echo "ghcr.io/opencraft-app/opencraft-server@${digest}";;
esac
`,
    { mode: 0o755 },
  );
  const result = spawnSync("bash", [script, tag], {
    cwd: directory,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH}`,
      DOCKER_LOG: log,
      COMMIT: commit,
      GH_TOKEN: "test-only",
      GITHUB_ACTOR: "test",
      IMAGE_ARCHIVE: join(directory, "image.tar.gz"),
      GITHUB_OUTPUT: join(directory, "output"),
      ...env,
    },
  });
  const read = (name) => {
    try {
      return readFileSync(join(directory, name), "utf8");
    } catch {
      return "";
    }
  };
  return {
    status: result.status,
    stderr: result.stderr + result.stdout,
    docker: read("docker.log"),
    output: read("output"),
  };
}

test("a new version is pushed, verified from the registry and named by digest", (t) => {
  const r = publish(t, "v0.3.0-beta.2");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.docker, /^push ghcr\.io\/opencraft-app\/opencraft-server:0\.3\.0-beta\.2$/mu);
  const removed = r.docker.indexOf(`image rm --force ${tested}`);
  assert.ok(
    r.docker.indexOf("push ") < removed && removed < r.docker.indexOf("pull "),
    "local copies go before the pull",
  );
  assert.doesNotMatch(r.docker, /:latest/u, "a beta never moves latest");
  assert.equal(r.output, `image=ghcr.io/opencraft-app/opencraft-server@${digest}\n`);
});

test("a stable version also moves latest", (t) => {
  const r = publish(t, "v0.3.0");
  assert.equal(r.status, 0, r.stderr);
  assert.match(
    r.docker,
    /imagetools create --tag ghcr\.io\/opencraft-app\/opencraft-server:latest ghcr\.io\/opencraft-app\/opencraft-server@sha256:2{64}/u,
  );
});

test("a rerun pushes nothing when the version already holds the tested image", (t) => {
  const r = publish(t, "v0.3.0", { PUBLISHED: "yes" });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.docker, /^push /mu);
  assert.match(r.docker, /^pull ghcr\.io\/opencraft-app\/opencraft-server:0\.3\.0$/mu);
});

test("a published version never moves to a different image", (t) => {
  const r = publish(t, "v0.3.0", { PUBLISHED: "yes", PULLED_ID: `sha256:${"9".repeat(64)}` });
  assert.notEqual(r.status, 0);
  assert.doesNotMatch(r.docker, /^push |:latest/mu);
  assert.equal(r.output, "");
});

test("an image built from another commit or a bad tag is refused before any push", (t) => {
  for (const [tag, env] of [
    ["v0.3.0", { REVISION: "0".repeat(40) }],
    ["0.3.0", {}],
    ["v0.3.0-rc.1", {}],
  ]) {
    const r = publish(t, tag, env);
    assert.notEqual(r.status, 0, tag);
    assert.doesNotMatch(r.docker, /^push /mu, tag);
  }
});
