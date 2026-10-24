import { parseThreadPinsSnapshot, type ThreadPinsSnapshot } from "@opencraft/appserver-protocol";

/** One initialized connection's metadata transaction coordinator; no persistence. */
export class ThreadPinningResource {
  private revision = 0;
  private readonly writes = new Map<string, Promise<void>>();
  private supported = false;
  constructor(private readonly port: {
    read(): Promise<unknown>;
    write(threadId: string, pinned: boolean): Promise<{ pinned: boolean }>;
    current(): boolean;
  }) {}
  available() { return this.port.current() && this.supported; }
  private assertCurrent() { if (!this.port.current()) throw new Error("会话连接已改变，请刷新列表后重试"); }

  async read(): Promise<ThreadPinsSnapshot> {
    for (;;) {
      this.assertCurrent();
      await Promise.all(this.writes.values());
      this.assertCurrent();
      const revision = this.revision;
      const snapshot = parseThreadPinsSnapshot(await this.port.read());
      this.assertCurrent();
      if (revision !== this.revision) continue;
      this.supported = snapshot.supported;
      return snapshot;
    }
  }

  async set(threadId: string, pinned: boolean): Promise<void> {
    this.assertCurrent();
    if (!this.supported || !threadId || typeof pinned !== "boolean") throw new Error("此连接当前不支持置顶");
    ++this.revision;
    const previous = this.writes.get(threadId) ?? Promise.resolve();
    const operation = previous.then(async () => {
      this.assertCurrent();
      const result = await this.port.write(threadId, pinned);
      this.assertCurrent();
      if (result.pinned !== pinned) throw new Error("置顶结果尚未确认，请刷新列表核对");
    });
    const settled = operation.then(() => {}, () => {});
    this.writes.set(threadId, settled);
    try { await operation; }
    finally {
      ++this.revision;
      if (this.writes.get(threadId) === settled) this.writes.delete(threadId);
    }
  }
}
