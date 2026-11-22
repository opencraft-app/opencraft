#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const [, , configPath, output] = process.argv;
if (!configPath || !output) throw new Error("Usage: upgrade-environment.mjs LOCAL_CONFIG.json NEW_REPORT.json");
const { sshAlias, ...config } = JSON.parse(readFileSync(configPath, "utf8"));
if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(sshAlias)) throw new Error("Invalid SSH alias");
const probe = String.raw`
import hashlib, json, re, subprocess, sys, urllib.request
cfg = json.load(sys.stdin)
checks = {}
def record(key, ok, evidence):
    checks[key] = dict(status="pass" if ok else "fail", evidence=evidence)
def read(path):
    with urllib.request.urlopen("http://127.0.0.1:" + str(int(cfg["port"])) + path, timeout=5) as response:
        return json.load(response)
def run(*args):
    return subprocess.check_output(args, timeout=12, stderr=subprocess.DEVNULL, universal_newlines=True)
def check(key, fn):
    try:
        ok, data = fn()
        record(key, ok, data)
    except Exception as error:
        record(key, False, {"reason": type(error).__name__})
def identity():
    health = read("/health")
    pid = int(health["core"]["pid"])
    with open("/proc/%d/cmdline" % pid, "rb") as f:
        argv = f.read().split(b"\0")
    program = cfg["coreProgram"]
    if not program.startswith("/") or program.encode() not in argv:
        raise ValueError("Core program does not match live process")
    with open("/proc/%d/root%s" % (pid, program), "rb") as f:
        hasher = hashlib.sha256()
        for block in iter(lambda: f.read(1024 * 1024), b""):
            hasher.update(block)
        digest = hasher.hexdigest()
    try:
        web = read("/version.json")
    except Exception:
        web = {}
    result = dict(pid=pid, version=health.get("version"), buildId=health.get("buildId"),
                  webSourceRevision=web.get("sourceRevision"), webBuildId=web.get("buildId"), coreSha256=digest)
    return bool(result["buildId"]) and all(result.get(k) == v for k, v in cfg.get("expectedIdentity", {}).items()), result
def services():
    counters = {}
    for unit in cfg["units"]:
        result = dict(line.split("=", 1) for line in run("systemctl", "show", "--property=ActiveState,NRestarts", "--", unit).splitlines())
        count = len(run("journalctl", "--no-pager", "-q", "-o", "json", "-p", "err", "--since", cfg["since"], "-u", unit).splitlines())
        counters[unit] = dict(state=result.get("ActiveState"), restarts=int(result["NRestarts"]), journalErrors=count)
    for container in cfg.get("containers", []):
        row = run("docker", "inspect", "--format", '{{.State.Status}} {{.RestartCount}} {{.Image}} {{index .Config.Labels "org.opencontainers.image.revision"}}', container).strip().split()
        counters[container] = dict(state=row[0], restarts=int(row[1]), image=row[2], sourceRevision=row[3] if len(row) == 4 else None)
    return bool(counters) and all(v["state"] in ("active", "running") for v in counters.values()), counters
def health():
    data = read("/health")
    deps = data.get("dependencies", {})
    return data.get("ok") is True and all(v == "ready" for v in deps.values()), {"dependencies": deps}
check("health", health)
check("runtimeIdentity", identity)
check("serviceCounters", services)
print(json.dumps(checks))
`;
const command = "python3 -c '" + probe.replaceAll("'", "'\\''") + "'";
let checks;
try {
  checks = JSON.parse(
    execFileSync("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "--", sshAlias, command], {
      input: JSON.stringify(config),
      encoding: "utf8",
      timeout: 90000,
      maxBuffer: 256 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    }),
  );
  const names = ["health", "runtimeIdentity", "serviceCounters"];
  if (
    !checks ||
    typeof checks !== "object" ||
    Array.isArray(checks) ||
    Object.keys(checks).sort().join() !== names.sort().join() ||
    Object.values(checks).some(
      (check) =>
        !check ||
        typeof check !== "object" ||
        Array.isArray(check) ||
        Object.keys(check).sort().join() !== "evidence,status" ||
        !["pass", "fail"].includes(check.status) ||
        !check.evidence ||
        typeof check.evidence !== "object" ||
        Array.isArray(check.evidence),
    )
  ) {
    throw Error("Invalid environment probe receipt");
  }
} catch {
  checks = { transport: { status: "fail", evidence: { reason: "Target probe failed or timed out" } } };
}
const pass = Object.values(checks).filter((check) => check.status === "pass").length;
const fail = Object.keys(checks).length - pass;
writeFileSync(
  output,
  JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString(), checks }, null, 2) + "\n",
  { flag: "wx", mode: 0o600 },
);
console.log(`Environment smoke: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
