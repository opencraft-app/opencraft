import { Context, Service } from "@deepseek-ai/cordis";

import type { ChatDirectiveHandler } from "../contracts";

declare module "@deepseek-ai/cordis" {
  interface Context {
    chatDirectives: ChatDirectiveRegistryService;
  }
}

export class ChatDirectiveRegistryService extends Service {
  private readonly handlers = new Map<string, ChatDirectiveHandler>();

  constructor(ctx: Context) {
    super(ctx, "chatDirectives");
    ctx.effect(() => () => this.handlers.clear());
  }

  register(handler: ChatDirectiveHandler): () => void {
    if (this.handlers.has(handler.name)) throw new Error(`Chat directive ${handler.name} already exists`);
    this.handlers.set(handler.name, handler);
    return () => {
      if (this.handlers.get(handler.name) === handler) this.handlers.delete(handler.name);
    };
  }

  resolve(name: string): ChatDirectiveHandler | null {
    return this.handlers.get(name) ?? null;
  }
}
