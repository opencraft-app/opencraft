import { Context, Service } from "@deepseek-ai/cordis";
import type { ChatDocumentNode } from "@opencraft/chat-document";

import type { ChatNodeRenderer, ChatRenderContext } from "../contracts";

declare module "@deepseek-ai/cordis" {
  interface Context {
    chatNodeRenderers: ChatNodeRendererRegistryService;
  }
}

export class ChatNodeRendererRegistryService extends Service {
  private readonly byName = new Map<string, ChatNodeRenderer>();
  private readonly listeners = new Set<() => void>();
  private snapshot: readonly ChatNodeRenderer[] = [];

  constructor(ctx: Context) {
    super(ctx, "chatNodeRenderers");
    ctx.effect(() => () => {
      this.byName.clear();
      this.publish();
    });
  }

  register(renderer: ChatNodeRenderer): () => void {
    if (renderer.name.length === 0) throw new RangeError("Chat renderer name must not be empty");
    if (renderer.kinds.length === 0) throw new RangeError(`Chat renderer ${renderer.name} must handle a node kind`);
    if (this.byName.has(renderer.name)) throw new Error(`Chat renderer ${renderer.name} already exists`);
    this.byName.set(renderer.name, renderer);
    this.publish();
    return () => {
      if (this.byName.get(renderer.name) !== renderer) return;
      this.byName.delete(renderer.name);
      this.publish();
    };
  }

  resolve(
    renderers: readonly ChatNodeRenderer[],
    node: ChatDocumentNode,
    context: ChatRenderContext,
  ): ChatNodeRenderer | null {
    return renderers.find((renderer) =>
      renderer.kinds.includes(node.kind) && (renderer.matches?.(node, context) ?? true)
    ) ?? null;
  }

  getSnapshot = (): readonly ChatNodeRenderer[] => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private publish(): void {
    this.snapshot = [...this.byName.values()].sort((left, right) => right.priority - left.priority);
    this.listeners.forEach((listener) => listener());
  }
}
