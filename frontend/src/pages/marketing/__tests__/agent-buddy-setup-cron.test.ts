// Execute the generated sandbox command against a fake Hermes CLI: this verifies
// shell/Python quoting, profile routing and a lost response with overlapping retries.
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildEnsureRoutineCommand, buildRoutineCommand } from "../agent-buddy-setup";

const exec = promisify(execFile);
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "buddy-cron-"));
  writeFileSync(path.join(dir, "hermes"), `#!/usr/bin/env python3
import json, os, sys, time
from pathlib import Path
args = sys.argv[1:]
assert args[:3] == ['-p', 'bot-test', 'cron'], args
root = Path(os.environ['HERMES_PROFILE_ROOT'])
assert root.name == 'bot-test', root
jobs = root / 'fake-jobs.json'
rows = json.loads(jobs.read_text()) if jobs.exists() else []
if args[3] == 'list':
    mode = os.environ.get('FAKE_LIST_MODE', '')
    if mode == 'failed': sys.exit(1)
    if mode == 'unknown': print('Unrecognized CLI output'); sys.exit(0)
    if not rows: print('No scheduled jobs. Create one with hermes cron create')
    for name in rows: print('  abcdef123 [paused]\\n    Name:      ' + name + '\\n    Schedule: daily')
else:
    time.sleep(0.15)
    rows.append(args[args.index('--name') + 1])
    jobs.write_text(json.dumps(rows))
`, { mode: 0o755 });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function run(command: string, mode = "") {
  return exec("/bin/sh", ["-c", command], {
    env: { ...process.env, HERMES_HOME: dir, PATH: `${dir}:${process.env.PATH}`, FAKE_LIST_MODE: mode },
  });
}

const routine = { label: "每天 08:00", desc: "生成晨报" };
const template = "助手 ' $(echo unsafe)";
const name = `${template} · ${routine.label}`;
function command() {
  return buildEnsureRoutineCommand(buildRoutineCommand(routine, template)!, name, "bot-test");
}

describe("sandbox cron recovery", () => {
  it("serializes overlapping creates and skips a paused job on retry", async () => {
    const cmd = command();
    await Promise.all([run(cmd), run(cmd)]);
    await run(cmd);
    expect(JSON.parse(readFileSync(path.join(dir, "profiles/bot-test/fake-jobs.json"), "utf8"))).toEqual([name]);
  });

  it.each(["failed", "unknown"])("never creates when the list is %s", async (mode) => {
    await expect(run(command(), mode)).rejects.toThrow();
    // Once listing is available, creation can proceed exactly once.
    await run(command());
    expect(JSON.parse(readFileSync(path.join(dir, "profiles/bot-test/fake-jobs.json"), "utf8"))).toEqual([name]);
  });
});
