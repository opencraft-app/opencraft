import { Service, type Inject } from "@deepseek-ai/cordis";
import type { AppServerConnection } from "../types/appserver.ts";
import type { HypernodeContext, HypernodeServices } from "../types/context.ts";
import type { HostUserRecord } from "../types/host-policy.ts";

type Dependencies =
  | "appServer"
  | "credential"
  | "modelGateway"
  | "threadManager"
  | "threadSearch"
  | "userDirectory";

interface AdministratorInvocation {
  connection?: AppServerConnection;
  threadId?: string | null;
}

export class AdministratorService extends Service {
  static inject = [
    "appServer",
    "credential",
    "modelGateway",
    "threadManager",
    "threadSearch",
    "userDirectory",
  ] satisfies Inject<Pick<HypernodeServices, Dependencies>>;

  declare protected ctx: HypernodeContext<Dependencies>;

  constructor(ctx: HypernodeContext<Dependencies>) {
    super(ctx, "administrator");
    ctx.effect(() => ctx.appServer.register(
      "hypernode/administrator/read",
      (_params, connection) => ({
        threadId: ctx.threadManager.list()
          .find((thread) => ctx.threadManager.isRoot(thread.id))?.id ?? null,
        agentAvailable: this.hasAgent(connection),
        searchAvailable: ctx.threadSearch.available,
      }),
    ));
  }

  hasAgent(connection: AppServerConnection): boolean {
    const userId = connection.identity?.id;
    if (!userId) return false;
    if (this.ctx.modelGateway.visibleRecordsForUser(userId).length > 0) return true;
    return this.ctx.credential.resolveCodexUser(userId) !== null;
  }

  currentUser(connection: AppServerConnection | undefined): HostUserRecord | null {
    const userId = connection?.identity?.id;
    return userId ? this.ctx.userDirectory.find(userId) : null;
  }

  isAdministrator(connection: AppServerConnection | undefined): boolean {
    return this.currentUser(connection)?.role === "administrator";
  }

  search(input: unknown, invocation: AdministratorInvocation = {}): string {
    // Search is temporarily shared by every registered SSH user.  Keep the
    // identity check so an unbound synthetic connection cannot turn the FTS
    // index into an anonymous data endpoint.
    const user = this.currentUser(invocation.connection);
    if (!user) {
      return "只有已登录的 HyperNode 用户可以搜索全局会话。";
    }
    return this.ctx.threadSearch.render(input, {
      // Searching the management Thread itself would feed the Agent's own
      // query and answer back into its next search.  Exclusion is an
      // authority-side invariant rather than a prompt convention.
      excludeThreadId: invocation.threadId ?? null,
      actorPrincipalId: invocation.connection?.identity?.id ?? user.id,
    });
  }

  unavailableGuidance(): string {
    return [
      "管理员 Agent 暂时没有可用模型。",
      "",
      "请运行 [$models](/workspace/.codex/skills/models/SKILL.md) 配置公共或个人模型；" +
        "如需使用 Codex 订阅，也可以运行 " +
        "[$codex-account](/workspace/.codex/skills/codex-account/SKILL.md) 完成绑定。",
      "配置完成后，直接在本会话中提问即可进入正常 Agent，不需要再选择菜单。",
    ].join("\n");
  }
}
