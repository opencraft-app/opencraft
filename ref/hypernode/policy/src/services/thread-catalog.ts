import { Service, type Inject } from "@deepseek-ai/cordis";
import type { AppServerConnection } from "../types/appserver.ts";
import type { HypernodeContext, HypernodeServices } from "../types/context.ts";
import type { ThreadCatalogThread } from "../types/thread-catalog.ts";

type Dependencies =
  | "allThread"
  | "appServer"
  | "rootThread"
  | "threadManager"
  | "threadProjectBinding";

export function reconcileCatalogStatuses(
  ctx: Pick<HypernodeContext<"appServer">, "appServer">,
  connection: AppServerConnection,
  threads: ThreadCatalogThread[],
): void {
  connection.threadCatalogStatuses ??= new Map();
  for (const thread of threads) {
    const status = thread.status ?? { type: "idle" };
    const serialized = JSON.stringify(status);
    if (connection.threadCatalogStatuses.get(thread.id) === serialized) continue;
    connection.threadCatalogStatuses.set(thread.id, serialized);
    ctx.appServer.notifyAfter(connection, "thread/status/changed", {
      threadId: thread.id,
      status,
    });
  }
}

export class ThreadCatalogService extends Service {
  static inject = [
    "allThread",
    "appServer",
    "rootThread",
    "threadManager",
    "threadProjectBinding",
  ] satisfies Inject<Pick<HypernodeServices, Dependencies>>;

  constructor(ctx: HypernodeContext<Dependencies>) {
    super(ctx, "threadCatalog");
    ctx.effect(() => ctx.appServer.register("thread/list", (params, connection) => {
      ctx.rootThread.get();
      ctx.allThread.get();
      ctx.threadProjectBinding.observeList(params, connection);
      const page = ctx.threadManager.listPage(params, connection.identity?.id ?? null);
      // Desktop may reconnect after optimistically rendering a turn/start that
      // never reached the server. It does not necessarily resume the task that
      // remains selected; thread/list is the only reliable reconnect checkpoint.
      reconcileCatalogStatuses(ctx, connection, page.data);
      return page;
    }));
    ctx.effect(() => ctx.appServer.register("thread/loaded/list", (_params, connection) => {
      ctx.rootThread.get();
      ctx.allThread.get();
      return {
        data: ctx.threadManager.list(
          { archived: false },
          connection.identity?.id ?? null,
        ).filter(
          (thread) => thread.status.type !== "notLoaded",
        ),
      };
    }));
  }
}
