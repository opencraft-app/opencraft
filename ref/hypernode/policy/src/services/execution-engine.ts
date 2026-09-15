import { Service, type Inject } from "@deepseek-ai/cordis";
import type { HypernodeContext, HypernodeServices } from "../types/context.ts";
import type {
  EngineThreadPreparation,
  EngineTurnControl,
  EngineTurnStart,
  ExecutionEnginePort,
} from "../types/engine.ts";
import type { ExecutionProfile } from "./execution-profile.ts";

type Dependencies = "dshEngineAdapter";

/**
 * Engine registry boundary.  DSH is the first native adapter; Codex remains
 * available through its AppServer runtime adapter until that adapter is
 * migrated behind the same port.
 */
export class ExecutionEngineService extends Service implements ExecutionEnginePort {
  static inject = ["dshEngineAdapter"] satisfies Inject<
    Pick<HypernodeServices, Dependencies>
  >;

  declare protected ctx: HypernodeContext<Dependencies>;

  constructor(ctx: HypernodeContext<Dependencies>) {
    super(ctx, "executionEngine");
  }

  supports(profile: ExecutionProfile): boolean {
    return this.ctx.dshEngineAdapter.supports(profile);
  }

  hasThread(threadId: string): boolean {
    return this.ctx.dshEngineAdapter.hasThread(threadId);
  }

  retireThread(threadId: string): boolean {
    return this.ctx.dshEngineAdapter.retireThread(threadId);
  }

  prepareThread(input: EngineThreadPreparation): unknown {
    return this.ctx.dshEngineAdapter.prepareThread(input);
  }

  startTurn(input: EngineTurnStart): unknown {
    return this.ctx.dshEngineAdapter.startTurn(input);
  }

  steer(input: EngineTurnControl): void {
    this.ctx.dshEngineAdapter.steer(input);
  }

  interrupt(input: EngineTurnControl): void {
    this.ctx.dshEngineAdapter.interrupt(input);
  }
}
