import { Service, type Inject } from "@deepseek-ai/cordis";
import type { AppServerConnection } from "../types/appserver.ts";
import type { HypernodeContext, HypernodeServices } from "../types/context.ts";
import type { ThreadLifecycleThread } from "../types/thread-lifecycle.ts";
import type { VirtualSkillInputItem } from "../types/virtual-skill.ts";
import { cloudThreadName, uuidV7 } from "./thread-identity.ts";

type Dependencies =
  | "appServer"
  | "principal"
  | "threadManager"
  | "threadTitle"
  | "virtualSkills";

export class RootThreadService extends Service {
  static inject = [
    "appServer",
    "principal",
    "threadManager",
    "threadTitle",
    "virtualSkills",
  ] satisfies Inject<Pick<HypernodeServices, Dependencies>>;

  declare protected ctx: HypernodeContext<Dependencies>;
  readonly thread: ThreadLifecycleThread;

  constructor(ctx: HypernodeContext<Dependencies>) {
    super(ctx, "rootThread");
    const principal = ctx.principal.current();
    const rootId = policyStore.getOrInsert("rootThread", principal.id, uuidV7());
    const displayName = cloudThreadName("管理员");
    this.thread = ctx.threadManager.find(rootId) ?? ctx.threadManager.create({}, {
      id: rootId,
      name: displayName,
      preview: "HyperNode 管理员 Agent：可直接对话，也可调用会话搜索与节点管理 Skill。",
      status: { type: "idle" },
    }, {
      ownerPrincipalId: principal.id,
      visibility: "nodeShared",
      kind: "management",
    });
    if (this.thread.name !== displayName) {
      ctx.threadTitle.set(this.thread.id, "管理员", { source: "system" });
    }
    ctx.threadManager.markRoot(this.thread.id);
    ctx.effect(() => ctx.appServer.register("hypernode/rootThread/read", () => ({
      principalId: principal.id,
      thread: this.thread,
    })));
  }

  get(): ThreadLifecycleThread {
    return this.thread;
  }

  is(threadId: string): boolean {
    return threadId === this.thread.id;
  }

  execute(
    input: VirtualSkillInputItem[],
    connection: AppServerConnection,
    turnId: string | null = null,
  ): unknown {
    return this.ctx.virtualSkills.executeInput(input, {
      connection,
      threadId: this.thread.id,
      turnId,
    });
  }
}
