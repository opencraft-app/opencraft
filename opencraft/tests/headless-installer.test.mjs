import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const script = resolve("scripts/install-headless-linux.sh");

function run(...args) {
  return spawnSync("bash", [script, ...args], { encoding: "utf8" });
}

test("headless installer renders one persistent service for WebUI and WebSockets on port 80", () => {
  const directory = mkdtempSync(join(tmpdir(), "opencraft-installer-"));
  try {
    const result = run(
      "--allow-unauthenticated-public",
      "--render-dir", directory,
      "--state-name", "opencraft_test",
    );
    assert.equal(result.status, 0, result.stderr);
    const unit = readFileSync(join(directory, "opencraft-server.service"), "utf8");
    assert.match(unit, /DynamicUser=yes/u);
    assert.match(unit, /StateDirectory=opencraft_test/u);
    assert.match(unit, /Restart=on-failure/u);
    assert.match(unit, /ProtectSystem=strict/u);
    assert.match(unit, /--host 0\.0\.0\.0 --port 80 --data-dir \/var\/lib\/opencraft_test --allow-unauthenticated-public/u);
    assert.match(unit, /AmbientCapabilities=CAP_NET_BIND_SERVICE/u);
    assert.match(unit, /CapabilityBoundingSet=CAP_NET_BIND_SERVICE/u);
    assert.doesNotMatch(unit, /nginx|proxy/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("headless installer refuses public exposure without its explicit flag", () => {
  const directory = mkdtempSync(join(tmpdir(), "opencraft-installer-"));
  try {
    const result = run("--render-dir", directory);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /requires --allow-unauthenticated-public/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("headless installer validates port, state name and existing output", () => {
  const directory = mkdtempSync(join(tmpdir(), "opencraft-installer-"));
  try {
    const prefix = ["--allow-unauthenticated-public", "--render-dir", directory];
    assert.match(run(...prefix, "--port", "0").stderr, /invalid --port/u);
    assert.match(run(...prefix, "--state-name", "../escape").stderr, /invalid --state-name/u);
    assert.equal(run(...prefix).status, 0);
    assert.match(run(...prefix).stderr, /already contains installer output/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("high ports do not grant a bind capability", () => {
  const directory = mkdtempSync(join(tmpdir(), "opencraft-installer-"));
  try {
    const result = run("--allow-unauthenticated-public", "--render-dir", directory, "--port", "8089");
    assert.equal(result.status, 0, result.stderr);
    const unit = readFileSync(join(directory, "opencraft-server.service"), "utf8");
    assert.match(unit, /--port 8089/u);
    assert.doesNotMatch(unit, /AmbientCapabilities|CapabilityBoundingSet/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
