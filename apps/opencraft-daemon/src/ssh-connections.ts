import type { DatabaseOutcome } from "@opencraft/sqlite-node";
import { WorkerOwner, ownerEntry } from "@opencraft/worker-owner";
import type { SshCodexServerBinding } from "./ssh-codex-connections.js";
import {
  SshManagementError,
  sshBinding,
  type SshConnectionInput,
  type SshConnectionRecord,
} from "./ssh-connection-records.js";

type Owner = {
  save(
    serverId: string | null,
    revision: number,
    input: SshConnectionInput,
    trustedHostKey?: string,
  ): SshConnectionRecord;
  remove(serverId: string, revision: number): void;
  password(serverId: string, revision: number): string;
};

/**
 * SSH connections for a network process. A Worker owns the database, the
 * credential key and the known_hosts files; this thread reads the committed
 * records from memory and waits for writes asynchronously.
 */
export class SshConnections {
  private readonly records: Map<string, SshConnectionRecord>;
  private constructor(
    private readonly directory: string,
    private readonly owner: WorkerOwner<Owner>,
    readonly outcome: DatabaseOutcome,
    records: readonly SshConnectionRecord[],
  ) {
    this.records = new Map(records.map((record) => [record.serverId, record]));
  }

  static async open(directory: string): Promise<SshConnections> {
    const { owner, ready } = await WorkerOwner.open<
      Owner,
      { outcome: DatabaseOutcome; records: SshConnectionRecord[] }
    >(ownerEntry(import.meta.url, "ssh-connections"), {
      name: "SSH connection storage",
      workerData: { directory },
      errors: [SshManagementError],
    });
    return new SshConnections(directory, owner, ready.outcome, ready.records);
  }

  list(): SshConnectionRecord[] {
    return [...this.records.values()];
  }

  get(serverId: string): SshConnectionRecord {
    const record = this.records.get(serverId);
    if (!record) throw new SshManagementError("missing", 404);
    return record;
  }

  async save(
    serverId: string | null,
    revision: number,
    input: SshConnectionInput,
    trustedHostKey?: string,
  ): Promise<SshConnectionRecord> {
    const record = await this.owner.call.save(serverId, revision, input, trustedHostKey);
    this.records.set(record.serverId, record);
    return record;
  }

  async remove(serverId: string, revision: number): Promise<void> {
    if (this.get(serverId).revision !== revision) throw new SshManagementError("conflict", 409);
    await this.owner.call.remove(serverId, revision);
    this.records.delete(serverId);
  }

  /** A binding for an enabled connection. The password is read from the owner when SSH asks for it. */
  binding(serverId: string): SshCodexServerBinding {
    const record = this.get(serverId);
    if (!record.enabled) throw new SshManagementError("unavailable", 409);
    return sshBinding(this.directory, record, () => this.owner.call.password(serverId, record.revision));
  }

  close(): Promise<void> {
    return this.owner.close();
  }
}
