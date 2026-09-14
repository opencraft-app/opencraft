import { Service, type Inject } from "@deepseek-ai/cordis";
import type { HypernodeContext, HypernodeServices } from "../types/context.ts";
import type { ThreadLifecycleThread } from "../types/thread-lifecycle.ts";
import { uuidV7 } from "./thread-identity.ts";

type Dependencies = "appServer" | "principal" | "threadManager";

export class AllThreadService extends Service {
  static inject = ["appServer", "principal", "threadManager"] satisfies Inject<
    Pick<HypernodeServices, Dependencies>
  >;

  declare protected ctx: HypernodeContext<Dependencies>;
  readonly thread: ThreadLifecycleThread;

  constructor(ctx: HypernodeContext<Dependencies>) {
    super(ctx, "allThread");
    const principal = ctx.principal.current();
    const threadId = policyStore.getOrInsert("allThread", "node", uuidV7());
    this.thread = ctx.threadManager.find(threadId) ?? ctx.threadManager.create({}, {
      id: threadId,
      name: "All",
      preview: "Hypernode 全员群聊。",
      status: { type: "idle" },
    }, {
      ownerPrincipalId: principal.id,
      visibility: "nodeShared",
      kind: "all",
    });
    ctx.threadManager.markSystem(this.thread.id, "all");
    ctx.effect(() => ctx.appServer.register("hypernode/allThread/read", () => ({
      thread: this.thread,
    })));
  }

  get(): ThreadLifecycleThread {
    return this.thread;
  }

  is(threadId: string): boolean {
    return threadId === this.thread.id;
  }
}
