/** Logical client attachment is independent of sockets and persistent Thread identity. */
export class ThreadAttachments {
  private readonly clients = new Map<string, Set<string>>();
  private readonly loaded = new Set<string>();
  private readonly versions = new Map<string, number>();
  version(threadId: string): number { return this.versions.get(threadId) ?? 0; }
  private changed(threadId: string) { this.versions.set(threadId, this.version(threadId) + 1); }
  attach(clientId: string, threadId: string): void {
    const threads = this.clients.get(clientId) ?? new Set<string>();
    threads.add(threadId); this.clients.set(clientId, threads); this.loaded.add(threadId); this.changed(threadId);
  }
  has(clientId: string, threadId: string): boolean { return this.clients.get(clientId)?.has(threadId) ?? false; }
  count(threadId: string): number { return [...this.clients.values()].filter(threads => threads.has(threadId)).length; }
  isLoaded(threadId: string): boolean { return this.loaded.has(threadId); }
  detach(clientId: string, threadId: string): "unsubscribed" | "notSubscribed" | "notLoaded" {
    if (!this.loaded.has(threadId)) return "notLoaded";
    if (!this.clients.get(clientId)?.delete(threadId)) return "notSubscribed";
    this.changed(threadId); return "unsubscribed";
  }
  disconnect(clientId: string): string[] {
    const threads = [...this.clients.get(clientId) ?? []];
    this.clients.delete(clientId); threads.forEach(id => this.changed(id)); return threads;
  }
  unload(threadId: string): boolean {
    if (this.count(threadId)) return false;
    this.loaded.delete(threadId); this.changed(threadId); return true;
  }
  close(threadId: string): void {
    for (const threads of this.clients.values()) threads.delete(threadId);
    this.loaded.delete(threadId); this.changed(threadId);
  }
}
