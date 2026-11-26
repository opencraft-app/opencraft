import { mkdir, readFile, writeFile, rename, unlink, stat, chmod, mkdtemp, rm, open } from "node:fs/promises";
import { join, dirname, resolve, delimiter } from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { request as httpsRequest } from "node:https";
import { createServer, request as httpRequest } from "node:http";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { startLocalAgentHost, acquireLocalAgentStorageOwner } from "../../apps/local-agent-host/src/main.js";
import { readHostMachineIdentity } from "../../apps/local-agent-host/src/machine-identity.js";
import { connectRelay } from "../../plugins/relay-connect/src/server.js";
import { createLocalIngress } from "../../packages/hub-network/src/local-ingress.js";
import { machineLaunchAgentLabel, machineLaunchAgentPlist, machineServiceUnit } from "./service.mjs";
import { personalMachineOrigin } from "../../apps/local-agent-host/src/personal-machines.js";

const args = process.argv.slice(2);
const state = resolve(args[args.indexOf("--state") + 1] ?? "");
if (!args.includes("--state") || !args[args.indexOf("--state") + 1]) {
  throw new Error("--state is required");
}

const configPath = join(state, "connection.json");
const socketPath = join(state, "control.sock");
let config: Record<string, any>;
try {
  config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, any>;
} catch {
  throw new Error("Invalid machine connection file");
}

for (const key of [
  "PATH",
  "CODEX_HOME",
  "CURSOR_CONFIG_DIR",
  "CLAUDE_CONFIG_DIR",
  "GEMINI_CLI_HOME",
  "CODEBUDDY_CONFIG_DIR",
  "PI_CODING_AGENT_DIR",
]) {
  const value = config.nativeEnvironment?.[key];
  if (typeof value === "string" && !process.env[key]) process.env[key] = value;
}
if (typeof config.nativeEnvironment?.PATH === "string") {
  process.env.PATH = config.nativeEnvironment.PATH;
}
const home = homedir();
const extraBins = [
  join(home, ".local", "bin"),
  join(home, ".cargo", "bin"),
  join(home, ".bun", "bin"),
  join(home, "go", "bin"),
  join(home, ".npm-global", "bin"),
];
process.env.PATH = [...new Set([...(process.env.PATH ?? "").split(delimiter), ...extraBins].filter(Boolean))].join(delimiter);

personalMachineOrigin(config.origin);
if (
  config.schemaVersion !== 1
  || !/^[-a-f0-9]{36}$/u.test(config.id)
  || !/^[-a-f0-9]{36}$/u.test(config.hubId)
  || !/^[A-Za-z0-9_-]{43}$/u.test(config.credential)
) {
  throw new Error("Invalid machine identity");
}

const control = (method: string): Promise<string> =>
  new Promise((done, fail) => {
    const req = httpRequest(
      { socketPath, path: "/status", method, timeout: method === "DELETE" ? 60_000 : 2_000 },
      (res) => {
        let text = "";
        res.on("data", (chunk) => {
          text += chunk;
        });
        res.on("end", () => (res.statusCode === 200 ? done(text) : fail(new Error("Machine control unavailable"))));
      },
    );
    req.on("error", fail);
    req.on("timeout", () => req.destroy(new Error("Machine control timeout")));
    req.end();
  });

if (args.includes("--stop")) {
  await control("DELETE");
  process.exit(0);
}
if (args.includes("--status")) {
  console.log(await control("GET"));
  process.exit(0);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const updateAction = ["--update", "--check-update", "--rollback", "--recover"].find((value) => args.includes(value));
if (updateAction) {
  const { runUpdate } = await import("./update.mjs");
  await runUpdate(state, updateAction);
  process.exit(0);
}

const runtimeVersion = await readFile(join(root, ".machine-version"), "utf8")
  .then((value) => value.trim())
  .catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return "legacy";
  });

if (args.includes("--install")) {
  const executable = process.execPath;
  const launcher = join(state, "launcher.mjs");
  const launch = [executable, launcher, "--state", state];
  const installLauncher = async () => {
    await writeFile(`${launcher}.new`, await readFile(join(root, "scripts/personal-machine/launcher.mjs")), { mode: 0o600 });
    await rename(`${launcher}.new`, launcher);
    const quote = (value: string) => `'${value.replace(/'/gu, "'\\''")}'`;
    await writeFile(join(state, "opencraft-machine"), `#!/usr/bin/env bash\nexec ${launch.map(quote).join(" ")} "$@"\n`, { mode: 0o700 });
  };
  let managed = false;
  const exec = promisify(execFile);
  if (process.platform === "linux") {
    try {
      await exec("systemctl", ["--user", "show-environment"]);
      managed = true;
    } catch {
      // Explicit detached install when no user systemd manager exists.
    }
    if (managed) {
      const name = `opencraft-machine-${config.id}`;
      const folder = join(homedir(), ".config/systemd/user");
      await mkdir(folder, { recursive: true });
      const unit = machineServiceUnit(state, executable);
      const temporary = await mkdtemp(join(tmpdir(), "opencraft-service-"));
      try {
        const candidate = join(temporary, `${name}.service`);
        await writeFile(candidate, unit, { mode: 0o600 });
        await exec("systemd-analyze", ["--user", "verify", candidate], {
          env: { ...process.env, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid!()}` },
        });
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
      await installLauncher();
      await writeFile(join(folder, `${name}.service`), unit, { mode: 0o600 });
      await exec("systemctl", ["--user", "daemon-reload"]);
      await exec("systemctl", ["--user", "enable", `${name}.service`]);
      await exec("systemctl", ["--user", "restart", `${name}.service`]);
    }
  } else if (process.platform === "darwin" && process.env.OPENCRAFT_DISABLE_LAUNCHD !== "1") {
    const uid = process.getuid?.();
    if (uid !== undefined) {
      try {
        await exec("launchctl", ["print", `gui/${uid}`]);
        const label = machineLaunchAgentLabel(config.id);
        const folder = join(homedir(), "Library/LaunchAgents");
        await mkdir(folder, { recursive: true });
        const plist = machineLaunchAgentPlist(config.id, state, executable);
        const temporary = await mkdtemp(join(tmpdir(), "opencraft-launchd-"));
        try {
          const candidate = join(temporary, `${label}.plist`);
          await writeFile(candidate, plist, { mode: 0o600 });
          await exec("plutil", ["-lint", "-s", candidate]);
        } finally {
          await rm(temporary, { recursive: true, force: true });
        }
        await installLauncher();
        const plistPath = join(folder, `${label}.plist`);
        await writeFile(plistPath, plist, { mode: 0o600 });
        await exec("launchctl", ["bootout", `gui/${uid}`, plistPath]).catch(() => {});
        await exec("launchctl", ["bootstrap", `gui/${uid}`, plistPath]);
        await exec("launchctl", ["kickstart", "-k", `gui/${uid}/${label}`]);
        managed = true;
      } catch {
        // Fall back cleanly to detached background daemon when GUI launchd session is unavailable (e.g. sandboxed test).
      }
    }
  }
  if (!managed) {
    await installLauncher();
    try {
      await control("GET");
    } catch {
      const log = await open(join(state, "daemon.log"), "a", 0o600);
      const child = spawn(launch[0]!, launch.slice(1), {
        cwd: join(state, "runtime"),
        detached: true,
        stdio: ["ignore", log.fd, log.fd],
        env: process.env,
      });
      child.unref();
      await log.close();
    }
  }
  let connected = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const status = JSON.parse(await control("GET")) as { connected?: boolean; version?: string };
      if (status.connected && status.version === runtimeVersion) {
        connected = true;
        break;
      }
    } catch {
      // Wait until the child finishes startup and connects to the relay.
    }
    await new Promise((done) => setTimeout(done, 1_000));
  }
  if (!connected) {
    throw new Error("Machine did not connect. Check the HTTPS address and daemon/service logs before retrying.");
  }
  console.log(
    `OpenCraft machine connected. ${managed ? "User service enabled." : "Detached process; reboot startup is not configured."}`,
  );
  console.log(`Local controls: ${join(state, "opencraft-machine")} --status / --stop / --check-update / --update / --rollback / --recover`);
  process.exit(0);
}

let stopping = false;
try {
  await control("GET");
  throw new Error("Machine is already running");
} catch (error) {
  if (!(error as NodeJS.ErrnoException).code || !["ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code!)) {
    throw error;
  }
}

try {
  const info = await stat(socketPath);
  if (info.uid !== process.getuid?.()) throw new Error("Machine socket owner mismatch");
  await unlink(socketPath);
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

const data = join(state, "data");
await mkdir(data, { recursive: true, mode: 0o700 });
const machine = await readHostMachineIdentity(data);
if (config.machineId && config.machineId !== machine.machineId) {
  throw new Error("Machine identity changed");
}

if (config.phase !== "enrolled") {
  const url = `${config.origin}/__opencraft_machines/enroll?id=${config.id}`;
  const payload = JSON.stringify({
    credentialHash: createHash("sha256").update(config.credential).digest("hex"),
    machine,
  });
  const result = config.ca
    ? await new Promise<Record<string, unknown>>((resolvePromise, reject) => {
        const req = httpsRequest(
          url,
          {
            method: "POST",
            ca: config.ca,
            headers: { authorization: `Bearer ${config.secret}`, "content-type": "application/json" },
            timeout: 30_000,
          },
          (res) => {
            let body = "";
            res.on("data", (chunk) => {
              body += chunk;
              if (body.length > 16_384) res.destroy(new Error("Invalid enrollment reply"));
            });
            res.on("error", reject);
            res.on("end", () => {
              try {
                if (res.statusCode !== 200) throw new Error("Machine pairing failed or expired");
                resolvePromise(JSON.parse(body) as Record<string, unknown>);
              } catch (err) {
                reject(err);
              }
            });
          },
        );
        req.on("error", reject);
        req.on("timeout", () => req.destroy(new Error("Enrollment timeout")));
        req.end(payload);
      })
    : await (async () => {
        const res = await fetch(url, {
          method: "POST",
          headers: { authorization: `Bearer ${config.secret}`, "content-type": "application/json" },
          body: payload,
          signal: AbortSignal.timeout(30_000),
        });
        if (!res.ok) throw new Error("Machine pairing failed or expired");
        return (await res.json()) as Record<string, unknown>;
      })();
  if (result.hubId !== config.hubId || result.id !== config.id) {
    throw new Error("Hub identity mismatch");
  }
  config = { ...config, phase: "enrolled", machineId: machine.machineId };
  delete config.secret;
  await writeFile(`${configPath}.tmp`, JSON.stringify(config), { mode: 0o600 });
  await rename(`${configPath}.tmp`, configPath);
}

const release = await acquireLocalAgentStorageOwner(data);
let host: Awaited<ReturnType<typeof startLocalAgentHost>> | undefined;
try {
  const workspace = join(homedir(), "OpenCraft");
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  const selfUpdate = async () => {
    const log = await open(join(state, "remote-update.log"), "a", 0o600);
    try {
      const child = spawn(
        process.execPath,
        [
          "--import",
          join(state, "runtime/node_modules/tsx/dist/loader.mjs"),
          join(state, "runtime/scripts/personal-machine/daemon.ts"),
          "--state",
          state,
          "--update",
        ],
        { cwd: state, detached: true, stdio: ["ignore", log.fd, log.fd], env: process.env },
      );
      child.unref();
    } finally {
      await log.close();
    }
    return { started: true };
  };
  host = await startLocalAgentHost({
    dataDirectory: data,
    modelStorageDirectory: join(data, "models"),
    projectlessWorkspaceDirectory: workspace,
    runtimeDirectory: root,
    dshCapabilityPlugin: join(root, "apps/local-agent-host/src/dsh-capability-plugin.mjs"),
    dshExecutable: join(root, "runtime/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js"),
    selfUpdate,
  });
  const target = new URL(host.websocketUrl);
  const ingress = createLocalIngress(
    () => ({ port: Number(target.port), origin: "http://personal-machine", path: `${target.pathname}${target.search}` }),
    ["/rpc"],
  );
  const relay = connectRelay({
    relay: config.origin,
    credential: config.credential,
    ca: config.ca,
    headers: { "x-opencraft-machine-version": runtimeVersion },
    acceptStream: (stream) => ingress.accept(stream),
    allowLoopbackInsecure: new URL(config.origin).protocol === "http:",
  });
  const shutdown = async (reply?: () => Promise<void>) => {
    if (stopping) return;
    stopping = true;
    relay.close();
    ingress.close();
    controlServer.close();
    try {
      await host!.close();
    } finally {
      await release();
      await unlink(socketPath).catch(() => {});
    }
    await reply?.();
    process.exit(0);
  };
  const controlServer = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    const body = JSON.stringify({ connected: !stopping && relay.connected(), version: runtimeVersion, machine });
    if (req.method === "DELETE") {
      void shutdown(() => new Promise<void>((done) => res.end(body, done)));
    } else {
      res.end(body);
    }
  });
  await new Promise<void>((done) => controlServer.listen(socketPath, done));
  await chmod(socketPath, 0o600);
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => void shutdown());
  }
} catch (error) {
  await host?.close();
  await release();
  throw error;
}
