import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readdir, realpath, rm, writeFile, readFile, open, rename } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { GenerationColdReplacement } from "./generation-runtime.js";
import type { GenerationRecord } from "./generation-registry.js";
import { GenerationPeer, rpcRecord } from "./generation-peer.js";
import { generationCopyOwner } from "./generation-files.js";
import type { GenerationSupervisor } from "./generation-supervisor.js";

async function checkDatabases(directory: string): Promise<number> {
  let count = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) count += await checkDatabases(path);
    else if (entry.isFile() && /\.sqlite(?:3)?$/u.test(entry.name)) {
      const database = new DatabaseSync(path, { readOnly: true });
      try { if (!database.prepare("PRAGMA quick_check").all().every(row => Object.values(row).every(value => value === "ok"))) throw new Error("Native HOME database check failed"); }
      finally { database.close(); }
      count++;
    }
  }
  return count;
}

/** Validate a retired HOME under its original absolute pathname in a private mount namespace.
 * Native DBs/rollouts contain absolute paths, so opening a plain relocated copy is insufficient. */
export function coldHomeValidator(options: { directory: string; socketParentDirectory?: string; supervisor: GenerationSupervisor }) {
  const socketParent = options.socketParentDirectory ?? "/tmp";
  const pendingPath = (id: string) => join(options.directory, `${id}.pending.json`);
  const syncDirectory = async () => { const directory = await open(options.directory, "r"); try { await directory.sync(); } finally { await directory.close(); } };
  const recoverOne = async (old: GenerationRecord): Promise<void> => {
    let pending: { version: number; validationId: string; runtimeDataDirectory: string; socketDirectory: string };
    try { pending = JSON.parse(await readFile(pendingPath(old.id), "utf8")); }
    catch (reason) { if ((reason as NodeJS.ErrnoException).code === "ENOENT") return; throw reason; }
    if (pending.version !== 1 || !/^validation-[0-9a-f-]{36}$/u.test(pending.validationId) || pending.runtimeDataDirectory !== old.runtimeDataDirectory
      || !pending.socketDirectory.startsWith(join(socketParent, "v-")) || pending.socketDirectory.includes("/../")) throw new Error("Invalid cold HOME handoff receipt");
    const { externalUnit: _unit, ...definition } = old;
    // Only a persisted validation identity can be cleaned, never an executing generation.
    await options.supervisor.discardUnready({ ...definition, id: pending.validationId, endpoint: join(pending.socketDirectory, "control.sock"), state: "candidate", incarnation: 0 });
    await rm(pending.socketDirectory, { recursive: true, force: true });
    await rm(pendingPath(old.id)); await syncDirectory();
  };
  const validate: GenerationColdReplacement = async (old, current, threadIds) => {
    await mkdir(options.directory, { recursive: true, mode: 0o700 });
    await recoverOne(old);
    const attempt = join(options.directory, `${old.id}-${old.incarnation}-${randomUUID()}`);
    await mkdir(attempt, { recursive: true, mode: 0o700 });
    const configuredHome = join(old.runtimeDataDirectory, "runtime");
    const originalHome = await realpath(configuredHome), backup = join(attempt, "backup"), validation = join(attempt, "validation");
    if (originalHome !== configuredHome) throw new Error("Retired HOME identity changed before validation");
    // BindPaths' separator syntax is deliberately rejected for these deployment paths.
    if ([originalHome, validation].some(path => /[\s:\\]/u.test(path))) throw new Error("Cold HOME validation requires systemd paths without whitespace, colon or backslash");
    await cp(originalHome, backup, { recursive: true, dereference: false, verbatimSymlinks: true, preserveTimestamps: true });
    const backupDatabases = await checkDatabases(backup);
    await cp(backup, validation, { recursive: true, dereference: false, verbatimSymlinks: true, preserveTimestamps: true });
    // The configured routing socket parent is stable across TMPDIR changes.
    await generationCopyOwner(validation, old.executionUid ?? process.getuid!(), old.executionGid ?? process.getgid!());
    const socketDirectory = await mkdtemp(join(socketParent, "v-"));
    if (Buffer.byteLength(join(socketDirectory, "control.sock")) >= 108) throw new Error("Cold validation Unix socket path is too long");
    await generationCopyOwner(socketDirectory, old.executionUid ?? process.getuid!(), old.executionGid ?? process.getgid!());
    const { externalUnit: _unit, ...definition } = old;
    const candidate: GenerationRecord = { ...definition, id: `validation-${randomUUID()}`, endpoint: join(socketDirectory, "control.sock"),
      executable: current.executable, bundle: current.bundle, node: current.node, state: "candidate", incarnation: 0 };
    // This unit is independent of the routing owner. Persist its identity before starting it.
    const handoffTemporary = `${pendingPath(old.id)}.${randomUUID()}.tmp`;
    await writeFile(handoffTemporary, JSON.stringify({ version: 1, validationId: candidate.id,
      runtimeDataDirectory: old.runtimeDataDirectory, socketDirectory, attempt }) + "\n", { mode: 0o600, flag: "wx", flush: true });
    await rename(handoffTemporary, pendingPath(old.id)); await syncDirectory();
    let peer: GenerationPeer | undefined;
    try {
      const health = await options.supervisor.start(candidate, { homeCopy: validation });
      const connection = await GenerationPeer.open(health.nativeSocket, { clientInfo: { name: "opencraft-cold-home-readonly", version: "1" }, capabilities: { experimentalApi: true } }, {
        message: () => {}, disconnected: () => {},
      }); peer = connection.peer;
      // No resume, turn/start, tools or mutation are issued against the validation copy.
      const page = rpcRecord(await peer.call("thread/list", { limit: 1, useStateDbOnly: true }));
      if (!Array.isArray(page.data)) throw new Error("Cold HOME directory read failed");
      const ids = [...new Set([...threadIds, ...page.data.map(row => String(rpcRecord(row).id))])];
      for (const id of ids) {
        const result = rpcRecord(await peer.call("thread/read", { threadId: id, includeTurns: false }));
        if (rpcRecord(result.thread).id !== id) throw new Error("Cold HOME Thread identity mismatch");
      }
      peer.close(); peer = undefined;
      const identity = await options.supervisor.identify(candidate, health);
      await options.supervisor.stop(candidate, identity);
      const migratedDatabases = await checkDatabases(validation);
      const receipt = { version: 1, originalHome, backup, validation, backupDatabases, migratedDatabases,
        validatedThreadIds: ids, replacementExecutable: current.executable, cliSha256: identity.cliSha256,
        cliVersion: identity.cliVersion, readonlyNativeRequests: true, originalHomeReplaced: false };
      await writeFile(join(attempt, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600 }); return receipt;
    } finally {
      peer?.close();
      // An unready validation unit has never accepted tasks; retain its private evidence.
      await recoverOne(old);
    }
  };
  return Object.assign(validate, { recover: async (generations: readonly GenerationRecord[]) => {
    await mkdir(options.directory, { recursive: true, mode: 0o700 });
    for (const generation of generations) await recoverOne(generation);
  } });
}
