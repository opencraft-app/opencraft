import { Service, type Inject } from "@deepseek-ai/cordis";
import type { HypernodeContext, HypernodeServices } from "../types/context.ts";
import type {
  CollaborationModeListResponse,
  CollaborationModePort,
} from "../types/thread-metadata.ts";
import type { JsonRpcError } from "../types/appserver.ts";

type Dependencies = "appServer";

const LEGACY_PRESETS = [
  {
    name: "Plan",
    mode: "plan",
    model: null,
    reasoning_effort: "medium",
  },
  {
    name: "Default",
    mode: "default",
    model: null,
    reasoning_effort: null,
  },
] as const;

export class CollaborationModeService extends Service implements CollaborationModePort {
  static inject = ["appServer"] satisfies Inject<Pick<HypernodeServices, Dependencies>>;

  declare protected ctx: HypernodeContext<Dependencies>;

  constructor(ctx: HypernodeContext<Dependencies>) {
    super(ctx, "collaborationMode");
    ctx.effect(() => ctx.appServer.register(
      "collaborationMode/list",
      () => this.legacyResponse(),
    ));
  }

  legacyResponse(): CollaborationModeListResponse {
    return { data: LEGACY_PRESETS.map((preset) => ({ ...preset })) };
  }

  fallbackFor(error: JsonRpcError): CollaborationModeListResponse | null {
    return error.code === -32601 ? this.legacyResponse() : null;
  }
}
