import { Service, type Inject } from "@deepseek-ai/cordis";
import type { HypernodeContext, HypernodeServices } from "../types/context.ts";

type Dependencies = "appServer";

export class PermissionProfileService extends Service {
  static inject = ["appServer"] satisfies Inject<Pick<HypernodeServices, Dependencies>>;

  declare protected ctx: HypernodeContext<Dependencies>;

  constructor(ctx: HypernodeContext<Dependencies>) {
    super(ctx, "permissionProfile");
    ctx.effect(() => ctx.appServer.register("permissionProfile/list", () => ({
      data: [],
      nextCursor: null,
    })));
  }
}
