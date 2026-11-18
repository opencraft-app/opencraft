// node:test global setup for the test isolation preload (see test-isolation.mjs).
// It runs in the test runner process. After every test file has exited, a
// process still carrying this run's marker was left behind (for example a
// detached owner). Short-lived helpers such as a file's esbuild service exit
// with their parent, so only processes that survive a second look count.
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { MARKER, RUN } from "./test-isolation.mjs";

let run = null;

export async function globalSetup() {
  // A test runner started by a test inherits that test's isolation.
  if (process.env[MARKER] || process.platform !== "linux") return;
  run = randomUUID();
  process.env[RUN] = run;
}

export async function globalTeardown() {
  if (run === null) return;
  const first = scan(run);
  if (first.size === 0) return;
  await delay(1_500);
  const leaked = [...scan(run)].filter(([pid]) => first.has(pid));
  if (leaked.length === 0) return;
  for (const [pid] of leaked) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // It exited between the scan and the kill.
    }
  }
  const lines = leaked.map(([pid, file]) => `${file}: pid ${pid} ${commandLine(pid)}`);
  process.stderr.write(
    `\n[test-isolation] ${leaked.length} process(es) outlived their test file and were stopped:\n  ${lines.join("\n  ")}\n`,
  );
  process.exitCode = 1;
}

/** Map of pid to test file for live processes marked with this run. */
function scan(id) {
  const prefix = `${MARKER}=${id}|`;
  const found = new Map();
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
    try {
      const entry = readFileSync(`/proc/${name}/environ`, "latin1")
        .split("\0")
        .find((value) => value.startsWith(prefix));
      if (entry) found.set(Number(name), entry.slice(prefix.length));
    } catch {
      // Exited, or owned by another user.
    }
  }
  return found;
}

function commandLine(pid) {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "latin1").split("\0").join(" ").trim().slice(0, 160);
  } catch {
    return "";
  }
}
