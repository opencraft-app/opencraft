import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { mkdir, open, rename, stat, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Writable } from "node:stream";
import { finished } from "node:stream/promises";

// Each service owns one writer. File IO and rotation stay off the event loop;
// Writable backpressure bounds pending output even while the disk is slow.
export async function createServiceLog(directory, { maxBytes = 10 * 1024 ** 2, archives = 3 } = {}) {
  if (
    !isAbsolute(directory) ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 256 ||
    !Number.isSafeInteger(archives) ||
    archives < 1 ||
    archives > 20
  )
    throw new Error("Invalid service log configuration");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await stat(directory);
  if (info.uid !== process.getuid() || (info.mode & 0o077) !== 0)
    throw new Error("Service log directory must be private and owned by this user");
  const path = join(directory, "service.log");
  let handle, size;
  const openLog = async () => {
    handle = await open(
      path,
      constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    const file = await handle.stat();
    if (!file.isFile() || file.uid !== process.getuid() || (file.mode & 0o077) !== 0) {
      await handle.close();
      throw new Error("Service log must be a private regular file owned by this user");
    }
    size = file.size;
  };
  await openLog();
  const move = async (from, to) => {
    try {
      await rename(from, to);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  };
  return new Writable({
    write(chunk, _encoding, callback) {
      (async () => {
        if (size > 0 && size + chunk.length > maxBytes) {
          await handle.close();
          handle = null;
          await unlink(`${path}.${archives}`).catch((error) => {
            if (error.code !== "ENOENT") throw error;
          });
          for (let index = archives - 1; index >= 1; index--) await move(`${path}.${index}`, `${path}.${index + 1}`);
          await move(path, `${path}.1`);
          await openLog();
        }
        await handle.writeFile(chunk);
        size += chunk.length;
      })().then(() => callback(), callback);
    },
    destroy(error, callback) {
      (handle?.close() ?? Promise.resolve()).then(() => callback(error), callback);
    },
  });
}

const write = (stream, chunk) =>
  new Promise((accept, reject) => stream.write(chunk, (error) => (error ? reject(error) : accept())));

export async function runLoggedService({
  command,
  args,
  env = process.env,
  directory,
  stdout = process.stdout,
  stderr = process.stderr,
  signals = process,
  logOptions,
}) {
  const log = await createServiceLog(directory, logOptions);
  // Disk errors keep the existing Docker output channel alive. Do not terminate
  // active conversations because an observability volume filled up.
  let logFailure;
  log.on("error", (error) => {
    logFailure = error;
    stderr.write("OpenCraft service file logging failed; use Docker logs.\n");
  });
  const child = spawn(command, args, { env, stdio: ["inherit", "pipe", "pipe"], shell: false });
  const forward = (signal) => {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  };
  const terminate = () => forward("SIGTERM"),
    interrupt = () => forward("SIGINT");
  signals.on("SIGTERM", terminate);
  signals.on("SIGINT", interrupt);
  const pump = async (source, destination, stream) => {
    source.setEncoding("utf8");
    for await (const chunk of source) {
      await write(destination, chunk);
      // Keep every record below the rotation limit, including JSON escaping.
      const partSize = Math.max(1, Math.floor(((logOptions?.maxBytes ?? 10 * 1024 ** 2) - 128) / 12));
      for (let at = 0; at < chunk.length && !logFailure; at += partSize) {
        const entry =
          JSON.stringify({ time: new Date().toISOString(), stream, message: chunk.slice(at, at + partSize) }) + "\n";
        try {
          await write(log, entry);
        } catch {
          /* The error listener reports this once. */
        }
      }
    }
  };
  try {
    const exit = new Promise((accept, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => accept({ code, signal }));
    });
    const [result] = await Promise.all([
      exit,
      pump(child.stdout, stdout, "stdout"),
      pump(child.stderr, stderr, "stderr"),
    ]);
    return result;
  } finally {
    signals.off("SIGTERM", terminate);
    signals.off("SIGINT", interrupt);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    log.end();
    await finished(log).catch(() => {});
  }
}

async function main() {
  const service = process.argv[2];
  const entries = {
    brain: "native-host.mjs",
    hands: "native-hands.mjs",
    gateway: "container-gateway.mjs",
    proxy: "proxy-host.mjs",
  };
  if (!Object.hasOwn(entries, service))
    throw new Error("Usage: container-service.mjs brain|hands|gateway|proxy [arguments]");
  const directory = process.env.OPENCRAFT_LOG_DIR;
  if (!directory || !isAbsolute(directory)) throw new Error("Set OPENCRAFT_LOG_DIR to an absolute path");
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const result = await runLoggedService({
    command: join(root, "bin/node"),
    args: [join(root, "runtime", entries[service]), ...process.argv.slice(3)],
    directory: join(directory, service),
  });
  process.exitCode = result.code ?? (result.signal === "SIGINT" ? 130 : 143);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
