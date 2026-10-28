import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CodexAccountRetainedState, CodexAccountServiceOptions } from "@opencraft/account-pool-host";
import { parseCodexAuthFileReference } from "@opencraft/account-pool-host";
import { ACCOUNT_CORE_STATE_MAX_BYTES } from "../../../scripts/full-upgrade/account-core-limits.mjs";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fileDigest = async (path: string) => createHash("sha256").update(await readFile(path)).digest("hex");
const processEnvironment = new Set(["INVOCATION_ID", "JOURNAL_STREAM", "SYSTEMD_EXEC_PID", "NOTIFY_SOCKET", "WATCHDOG_PID", "WATCHDOG_USEC", "LISTEN_PID", "LISTEN_FDS", "LISTEN_FDNAMES", "SHLVL", "_"]);
const environmentDigest = () => digest(Object.fromEntries(Object.entries(process.env)
  .filter(([key]) => !processEnvironment.has(key)).sort(([a], [b]) => a.localeCompare(b))));
function privateJson(text: string) {
  try { return JSON.parse(text); }
  catch { throw new Error("Invalid private account JSON"); }
}
type Phase = "open" | "fenced" | "released" | "cold-ready";
interface State {
  schemaVersion: 1; epoch: number; phase: Phase; operationId?: string; fence?: string; sourceOwner?: string;
  retained?: CodexAccountRetainedState;
  sealed?: { storage: string; historicalCount: number;
    configurationSelectorSha256: string; cliSha256: string };
  ready?: { owner: string; identity: string };
  uncertain: { id: string; route: string }[];
}
export interface AccountOwnerExpectation { expectedOwner: string; expectedEpoch: number; operationId: string; fence: string }

async function privateInfo(path: string, directory = false) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile())
    || info.uid !== process.getuid?.() || (info.mode & 0o077)) throw new Error("Private account owner file required");
  return info;
}

/** Read every account row, credential reference and maintenance file; never return their contents. */
export async function readAccountStorage(directory: string) {
  await privateInfo(directory, true);
  const databasePath = join(directory, "account-pool.sqlite");
  await privateInfo(databasePath);
  for (const suffix of ["-wal", "-shm"]) await privateInfo(databasePath + suffix).catch(error => { if (error.code !== "ENOENT") throw error; });
  const db = new DatabaseSync(databasePath, { readOnly: true });
  const tables: { name: string; rows: number; sha256: string }[] = [];
  try {
    db.exec("BEGIN");
    if (db.prepare("PRAGMA quick_check").all().some(row => Object.values(row)[0] !== "ok")
      || db.prepare("PRAGMA foreign_key_check").all().length) throw new Error("Account database integrity failed");
    const schema = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all();
    for (const row of db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()) {
      const name = String(row.name), rows = db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).all();
      tables.push({ name, rows: rows.length, sha256: digest(rows) });
    }
    tables.push({ name: "schema", rows: schema.length, sha256: digest(schema) });
    db.exec("COMMIT");
  } finally { db.close(); }
  const files: { path: string; sha256: string; mode: number; uid: number }[] = [];
  async function walk(relative: string) {
    const path = join(directory, relative), info = await lstat(path).catch(error => { if (error.code !== "ENOENT") throw error; return null; });
    if (!info) return;
    await privateInfo(path, info.isDirectory());
    if (info.isDirectory()) {
      for (const name of (await readdir(path)).sort()) await walk(`${relative}/${name}`);
      return;
    }
    const bytes = await readFile(path);
    if (relative.startsWith("secrets/")) {
      const value = privateJson(bytes.toString("utf8"));
      if (relative.startsWith("secrets/host-")) {
        if (typeof value.hostId !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(value.token)) throw new Error("Invalid Host credential");
      } else if (relative.startsWith("secrets/account-") && value.kind === "codex-auth-file") {
        const reference = parseCodexAuthFileReference(value)!;
        await privateInfo(reference.path);
        const external = privateJson(await readFile(reference.path, "utf8"));
        if (typeof external.tokens?.access_token !== "string" || !external.tokens.access_token) throw new Error("Unreadable external credential");
        files.push({ path: `external:${digest(reference.path)}`, sha256: await fileDigest(reference.path), mode: (await lstat(reference.path)).mode & 0o777, uid: info.uid });
      } else if (!relative.startsWith("secrets/account-") || typeof value.accessToken !== "string" || !value.accessToken) {
        throw new Error("Unknown account credential file");
      }
    }
    files.push({ path: relative, sha256: createHash("sha256").update(bytes).digest("hex"), mode: info.mode & 0o777, uid: info.uid });
  }
  for (const path of ["secrets", "login", "refresh"]) await walk(path);
  return { tables, files, sha256: digest({ tables, files }) };
}

/** Account authority only. It never opens a native HOME or owns a router lease. */
export class AccountCoreOwner {
  readonly owner = randomUUID();
  readonly incarnation = randomUUID();
  private state: State = { schemaVersion: 1, epoch: 0, phase: "open", uncertain: [] };
  private failed = false;
  private sealedProcess = false;
  private transitioning = false;
  private activating = false;
  private calls = 0;
  private proof?: { identity: string; expiresAt: string; idle: boolean };
  private bootId = "";
  private readonly path: string;
  constructor(private readonly options: CodexAccountServiceOptions & { endpoint: string; appServerEndpoint?: string; authToken: string; runtimeDirectory: string }) {
    this.path = join(options.dataDirectory, "account-handoff.json");
  }
  async load() {
    await mkdir(this.options.dataDirectory, { recursive: true, mode: 0o700 });
    this.bootId = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
    try {
      const file = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = await file.stat();
        if (!info.isFile() || info.uid !== process.getuid?.() || info.mode & 0o077 || info.size > ACCOUNT_CORE_STATE_MAX_BYTES) throw new Error("Invalid account handoff permissions");
        const value = privateJson(await file.readFile("utf8"));
        if (value.schemaVersion !== 1 || !Number.isSafeInteger(value.epoch) || value.epoch < 0
          || !["open", "fenced", "released", "cold-ready"].includes(value.phase) || !Array.isArray(value.uncertain)
          || value.phase !== "open" && ![value.operationId, value.fence, value.sourceOwner].every(v => typeof v === "string" && v.length > 0)
          || ["released", "cold-ready"].includes(value.phase) && (!value.sealed || typeof value.sealed.storage !== "string" || !value.retained)) throw new Error("Invalid account handoff state");
        this.state = value;
      } finally { await file.close(); }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (this.state.phase === "fenced") throw new Error("Account old writer release is unconfirmed; recovery required");
    // Verify before login recovery, schema opening or affinity pruning can mutate anything.
    if (this.state.phase !== "open" && (await readAccountStorage(this.options.dataDirectory)).sha256 !== this.state.sealed!.storage) {
      throw new Error("Account handoff current storage changed");
    }
  }
  isOpen = () => !this.failed && !this.sealedProcess && !this.activating && this.state.phase === "open";
  retained() { return this.state.retained; }
  enter(reconciliation = false) {
    const reconcilingSource = reconciliation && this.state.phase === "fenced" && this.state.sourceOwner === this.owner;
    if ((!this.isOpen() && !reconcilingSource) || this.failed || this.sealedProcess) throw new Error("Account Core admission is fenced");
    this.calls++;
    let done = false; return () => { if (!done) { done = true; this.calls--; } };
  }
  uncertain = async (route: string) => {
    // Delivery uncertainty blocks handoff. It is not a storage failure and must
    // not disable unrelated account traffic in an otherwise open owner.
    this.state.uncertain.push({ id: randomUUID(), route: ["/v1/responses", "/v1/images/generations", "/v1/images/edits", "/api/codex/ps/mcp"].includes(route) ? route : "other" });
    // This write participates in the same transition queue as the fence. A
    // request remains active until its uncertainty is durable.
    while (this.transitioning) await new Promise(resolve => setTimeout(resolve, 1));
    await this.transition(() => this.save(this.state));
  };
  snapshot() { return { ...structuredClone(this.state), owner: this.owner, activeCalls: this.calls,
    persistence: this.failed ? "unknown" : "ready", protocolVersion: 1, topology: "split", pid: process.pid, bootId: this.bootId, incarnation: this.incarnation }; }
  private check(input: AccountOwnerExpectation, existing = true) {
    if (this.failed || input.expectedOwner !== this.owner || input.expectedEpoch !== this.state.epoch
      || ![input.operationId, input.fence].every(v => typeof v === "string" && /^[a-zA-Z0-9_-]{1,128}$/u.test(v))
      || existing && (input.operationId !== this.state.operationId || input.fence !== this.state.fence)) throw new Error("Account owner handoff conflict");
  }
  checkInspection(input: AccountOwnerExpectation) { this.check(input); }
  private async save(state: State) {
    const bytes = this.serialized(state);
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    let file;
    try {
      file = await open(temporary, "wx", 0o600); await file.writeFile(bytes); await file.sync(); await file.close(); file = undefined;
      await rename(temporary, this.path);
      const dir = await open(this.options.dataDirectory, "r"); try { await dir.sync(); } finally { await dir.close(); }
      this.state = state;
    } catch (error) { this.failed = true; throw error; }
    finally { await file?.close(); await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
  }
  private serialized(state: State, reserve = 0) {
    const bytes = JSON.stringify(state);
    if (Buffer.byteLength(bytes) + reserve > ACCOUNT_CORE_STATE_MAX_BYTES) throw new Error("Account retained state exceeds protocol capacity");
    return bytes;
  }
  async fence(input: AccountOwnerExpectation) {
    this.check(input, this.state.phase !== "open");
    if (this.state.phase !== "open") return;
    this.state = { schemaVersion: 1, epoch: this.state.epoch + 1, phase: "fenced", operationId: input.operationId, fence: input.fence, sourceOwner: this.owner, uncertain: this.state.uncertain, retained: this.state.retained };
    await this.save(this.state);
  }
  async abortFence(input: AccountOwnerExpectation) {
    this.check(input);
    if (this.state.phase !== "fenced" || this.state.sourceOwner !== this.owner || this.sealedProcess) throw new Error("Account writer cannot resume after release began");
    await this.save({ ...this.state, phase: "open" });
  }
  inspect(observation: { activeCount: number; counts: unknown; historicalCount: number } | undefined) {
    const activeCount = observation ? observation.activeCount + this.calls + this.state.uncertain.length : this.calls + this.state.uncertain.length;
    const unknown = this.failed || this.state.uncertain.length > 0;
    const proof = { ownerId: this.owner, operationId: this.state.operationId, epoch: this.state.epoch, fence: this.state.fence,
      bootId: this.bootId, incarnation: this.incarnation, expiresAt: new Date(Date.now() + 15_000).toISOString(),
      coverage: unknown ? "unknown" : "complete", activeCount: unknown ? null : activeCount,
      historicalCount: observation?.historicalCount ?? this.state.sealed?.historicalCount ?? 0, counts: observation?.counts };
    this.proof = { identity: digest(proof), expiresAt: proof.expiresAt, idle: proof.coverage === "complete" && proof.activeCount === 0 };
    return { ...proof, identity: this.proof.identity };
  }
  async transition<T>(operation: () => Promise<T>) {
    if (this.transitioning) throw new Error("Account handoff transition is busy");
    this.transitioning = true; try { return await operation(); } finally { this.transitioning = false; }
  }
  async release(input: AccountOwnerExpectation & { proof?: string }, observation: { activeCount: number; historicalCount: number }, retained: () => CodexAccountRetainedState, stop: () => Promise<void>) {
    this.check(input);
    if (this.state.phase !== "fenced" || observation.activeCount + this.calls !== 0 || this.state.uncertain.length
      || !this.proof?.idle || this.proof.identity !== input.proof || Date.parse(this.proof.expiresAt) <= Date.now()) throw new Error("Account Core is not drained or proof expired");
    const carry = retained();
    const before = await readAccountStorage(this.options.dataDirectory);
    const released: State = { ...this.state, phase: "released", retained: carry, sealed: { storage: before.sha256,
      historicalCount: observation.historicalCount,
      configurationSelectorSha256: this.configuration(), cliSha256: await fileDigest(this.options.executable) }, ready: undefined };
    // Reserve the successor's ready identity before closing anything. An
    // oversized exact list is rejected while this source can still abort.
    this.serialized(released, 4096);
    if (this.calls !== 0 || this.failed || this.state.uncertain.length || this.proof.identity !== input.proof
      || Date.parse(this.proof.expiresAt) <= Date.now()) throw new Error("Account final drain proof changed");
    this.sealedProcess = true;
    await stop();
    const storage = await readAccountStorage(this.options.dataDirectory);
    if (storage.sha256 !== before.sha256) throw new Error("Account storage changed while closing writer");
    await this.save(released);
  }
  private configuration() {
    return digest({ dataDirectory: this.options.dataDirectory, endpoint: this.options.endpoint,
      executable: this.options.executable,
      environmentSha256: environmentDigest(),
      appServerEndpoint: this.options.appServerEndpoint, proxyPort: this.options.proxyPort, upstream: this.options.upstreamBaseUrl,
      nativeCodexHomeDirectory: this.options.nativeCodexHomeDirectory, runtimeDirectory: this.options.runtimeDirectory, token: digest(this.options.authToken) });
  }
  private async readiness() {
    const storage = await readAccountStorage(this.options.dataDirectory);
    if (!this.state.sealed || storage.sha256 !== this.state.sealed.storage) throw new Error("Account current storage differs from release receipt");
    const cliSha256 = await fileDigest(this.options.executable), configurationSelectorSha256 = this.configuration();
    if (this.state.sealed.cliSha256 !== cliSha256 || this.state.sealed.configurationSelectorSha256 !== configurationSelectorSha256) {
      throw new Error("Account handoff configuration or fixed CLI changed");
    }
    return { owner: this.owner, bootId: this.bootId, incarnation: this.incarnation, storage,
      manifestSha256: await fileDigest(await realpath(process.argv[1]!)),
      configurationSelectorSha256,
      capabilitySha256: digest({ handoff: 1, coreProtocol: 1, proxy: 1, node: process.version, abi: process.versions.modules, arch: process.arch,
        platform: process.platform, executable: this.options.executable, cliSha256 }),
      retainedSha256: digest(this.state.retained), storageOutcome: "ready" as const };
  }
  async coldReady(input: AccountOwnerExpectation) {
    this.check(input);
    if (!["released", "cold-ready"].includes(this.state.phase) || this.state.sourceOwner === this.owner) throw new Error("Cold account successor required");
    const proof = await this.readiness(), identity = digest(proof);
    await this.save({ ...this.state, phase: "cold-ready", ready: { owner: this.owner, identity } });
    return { ...proof, identity, evidenceId: identity };
  }
  async resume(input: AccountOwnerExpectation & { identity?: string }, activate: () => Promise<void> = async () => {}) {
    this.check(input);
    if (this.state.phase !== "cold-ready" || this.state.ready?.owner !== this.owner || input.identity !== this.state.ready.identity
      || digest(await this.readiness()) !== input.identity) throw new Error("Account cold readiness changed");
    // The durable open decision authorizes normal startup recovery. Admission
    // stays closed in this process until that recovery completes; a crash can
    // restart the same authorized startup path. Retained responsibility survives.
    this.activating = true;
    try {
      await this.save({ ...this.state, phase: "open", sealed: undefined, ready: undefined });
      await activate();
    } catch (error) { this.failed = true; throw error; }
    finally { this.activating = false; }
  }
}
