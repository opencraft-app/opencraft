import { Service, type Inject } from "@deepseek-ai/cordis";
import type { HypernodeContext, HypernodeServices } from "../types/context.ts";

type Dependencies = "appServer";

export class FeatureService extends Service {
  static inject = ["appServer"] satisfies Inject<Pick<HypernodeServices, Dependencies>>;

  declare protected ctx: HypernodeContext<Dependencies>;

  constructor(ctx: HypernodeContext<Dependencies>) {
    super(ctx, "feature");
    ctx.effect(() => ctx.appServer.register("experimentalFeature/list", () => ({
      data: [],
      nextCursor: null,
    })));
    ctx.effect(() => ctx.appServer.register("experimentalFeature/enablement/set", () => ({})));
  }
}
