import { Context, Service } from "@deepseek-ai/cordis";

import type { ThreadStreamRole } from "./models";

declare module "@deepseek-ai/cordis" {
  interface Context {
    threadStreamOwnership: ThreadStreamOwnershipService;
  }
}

export class ThreadStreamOwnershipService extends Service {
  private readonly roles = new Map<string, ThreadStreamRole>();

  constructor(ctx: Context) {
    super(ctx, "threadStreamOwnership");
  }

  get(threadId: string): ThreadStreamRole | null {
    return this.roles.get(threadId) ?? null;
  }

  set(threadId: string, role: ThreadStreamRole | null): void {
    if (role === null) this.roles.delete(threadId);
    else this.roles.set(threadId, role);
  }

  resetAfterReconnect(): readonly string[] {
    const affected = [...this.roles.keys()];
    this.roles.clear();
    return affected;
  }
}
