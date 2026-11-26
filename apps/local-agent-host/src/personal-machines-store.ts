import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { parseRuntimeMachineIdentity, type RuntimeMachineIdentity } from "@opencraft/appserver-protocol";

export interface MachineRecord {
  readonly id: string;
  readonly pairHash: string;
  readonly credentialHash: string | null;
  readonly expiresAt: number;
  readonly machine: RuntimeMachineIdentity | null;
}

export interface PersonalMachineAuthorityState {
  readonly schemaVersion: 1;
  readonly hubId: string;
  readonly ownerActorId: string;
  readonly machines: readonly MachineRecord[];
}

const PAIRING_TTL_MS = 15 * 60_000;
const MAX_PERSONAL_MACHINES = 64;

async function writePrivateAtomic(targetPath: string, payload: string): Promise<void> {
  const tempPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(tempPath, "w", 0o600);
  try {
    await handle.writeFile(payload, "utf8");
    await handle.datasync();
  } finally {
    await handle.close();
  }
  await rename(tempPath, targetPath);
}

function validateState(raw: unknown, expectedOwnerActorId: string): PersonalMachineAuthorityState {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("Invalid personal machine authority");
  }
  const input = raw as Record<string, unknown>;
  if (
    input.schemaVersion !== 1 ||
    input.ownerActorId !== expectedOwnerActorId ||
    typeof input.hubId !== "string" ||
    !input.hubId.trim() ||
    !Array.isArray(input.machines)
  ) {
    throw new Error("Invalid personal machine authority");
  }
  const machines: MachineRecord[] = input.machines.map((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error("Invalid machine record");
    }
    const row = entry as Record<string, unknown>;
    if (
      typeof row.id !== "string" ||
      !/^[a-f0-9-]{36}$/u.test(row.id) ||
      typeof row.pairHash !== "string" ||
      !/^[a-f0-9]{64}$/u.test(row.pairHash) ||
      typeof row.expiresAt !== "number" ||
      !Number.isFinite(row.expiresAt) ||
      (row.credentialHash !== null &&
        (typeof row.credentialHash !== "string" || !/^[a-f0-9]{64}$/u.test(row.credentialHash)))
    ) {
      throw new Error("Invalid machine record");
    }
    const machine = row.machine === null ? null : parseRuntimeMachineIdentity(row.machine);
    if (row.credentialHash !== null && machine === null) {
      throw new Error("Enrolled machine record is missing identity");
    }
    return Object.freeze({
      id: row.id,
      pairHash: row.pairHash,
      credentialHash: row.credentialHash,
      expiresAt: row.expiresAt,
      machine,
    });
  });
  return Object.freeze({
    schemaVersion: 1,
    hubId: input.hubId,
    ownerActorId: expectedOwnerActorId,
    machines: Object.freeze(machines),
  });
}

/**
 * Asynchronous FIFO owner for an Actor's personal machine enrollment ledger.
 * Hot-path control/status checks read the in-memory committed projection;
 * mutations serialize through an async durability queue without blocking the
 * network main thread.
 */
export class PersonalMachineStore {
  state!: PersonalMachineAuthorityState;
  private readonly filePath: string;
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  private fenced = false;
  readonly ready: Promise<void>;

  constructor(
    private readonly directory: string,
    private readonly ownerActorId: string,
    private readonly onFailure?: () => void,
  ) {
    this.filePath = join(directory, "personal-machines.json");
    this.ready = this.initialize();
  }

  private async initialize(): Promise<void> {
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      try {
        const text = await readFile(this.filePath, "utf8");
        this.state = validateState(JSON.parse(text), this.ownerActorId);
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
        const initial: PersonalMachineAuthorityState = Object.freeze({
          schemaVersion: 1,
          hubId: randomUUID(),
          ownerActorId: this.ownerActorId,
          machines: Object.freeze([]),
        });
        await writePrivateAtomic(this.filePath, JSON.stringify(initial));
        this.state = initial;
      }
    } catch (error) {
      this.fence();
      throw error;
    }
  }

  get available(): boolean {
    return !this.closed && !this.fenced && Boolean(this.state);
  }

  /** Permanently fences this owner after an unrecoverable storage fault. */
  fence(): void {
    if (this.fenced) return;
    this.fenced = true;
    this.onFailure?.();
  }

  async command(
    method: "create" | "claim" | "revoke",
    params: Record<string, unknown> = {},
  ): Promise<PersonalMachineAuthorityState> {
    await this.ready;
    if (!this.available) throw new Error("Machine storage unavailable");
    const run = this.queue.then(async () => {
      if (!this.available) throw new Error("Machine storage unavailable");
      const current = this.state;
      let next = current;
      if (method === "create") {
        const now = Date.now();
        const rows = current.machines.filter((row) => row.credentialHash !== null || row.expiresAt > now);
        if (rows.length >= MAX_PERSONAL_MACHINES) throw new Error("Personal machine limit");
        if (typeof params.pairHash !== "string" || !/^[a-f0-9]{64}$/u.test(params.pairHash)) {
          throw new Error("Invalid pairing");
        }
        const record: MachineRecord = Object.freeze({
          id: randomUUID(),
          pairHash: params.pairHash,
          credentialHash: null,
          expiresAt: now + PAIRING_TTL_MS,
          machine: null,
        });
        next = Object.freeze({ ...current, machines: Object.freeze([...rows, record]) });
      } else if (method === "claim") {
        const row = current.machines.find(
          (candidate) => candidate.id === params.id && candidate.pairHash === params.pairHash,
        );
        if (
          !row ||
          (row.credentialHash === null && row.expiresAt <= Date.now()) ||
          typeof params.credentialHash !== "string" ||
          !/^[a-f0-9]{64}$/u.test(params.credentialHash)
        ) {
          throw new Error("Pairing unavailable");
        }
        const machine = parseRuntimeMachineIdentity(params.machine);
        if (row.credentialHash !== null) {
          if (row.credentialHash !== params.credentialHash || row.machine?.machineId !== machine.machineId) {
            throw new Error("Machine already claimed");
          }
          return current;
        }
        next = Object.freeze({
          ...current,
          machines: Object.freeze(
            current.machines.map((candidate) =>
              candidate.id === row.id
                ? Object.freeze({ ...candidate, credentialHash: params.credentialHash as string, machine })
                : candidate,
            ),
          ),
        });
      } else if (method === "revoke") {
        if (typeof params.id !== "string") throw new Error("Invalid machine");
        next = Object.freeze({
          ...current,
          machines: Object.freeze(current.machines.filter((candidate) => candidate.id !== params.id)),
        });
      } else {
        throw new Error("Invalid machine operation");
      }
      try {
        await writePrivateAtomic(this.filePath, JSON.stringify(next));
      } catch (error) {
        this.fence();
        throw error;
      }
      this.state = next;
      return next;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.queue.catch(() => undefined);
  }
}
