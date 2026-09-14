import { Service, type Inject } from "@deepseek-ai/cordis";
import type {
  TransparentThreadActivationDecision,
  TransparentThreadActivationPort,
  TransparentThreadActivationRequest,
} from "../types/transparent-thread-activation.ts";
import type { HypernodeContext, HypernodeServices } from "../types/context.ts";
import type { VirtualSkillInputItem } from "../types/virtual-skill.ts";
import { hasExplicitBuiltinVirtualSkill } from "./builtin-virtual-skill.ts";

const ACTIVATABLE_THREAD_KINDS = new Set(["conversation", "management"]);

type Dependencies =
  | "administrator"
  | "runtimeWorkspace"
  | "threadManager"
  | "transparentRuntimeAccess"
  | "virtualSkills";

function inputItems(value: unknown): VirtualSkillInputItem[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is VirtualSkillInputItem =>
    Boolean(item) && typeof item === "object" && !Array.isArray(item)
  );
}

/**
 * Decides whether an outer Thread may enter the execution compatibility
 * boundary. It never starts an engine; it only materializes the durable
 * Thread classification that downstream Turn services require.
 */
export class TransparentThreadActivationService extends Service
  implements TransparentThreadActivationPort {
  static inject = [
    "administrator",
    "runtimeWorkspace",
    "threadManager",
    "transparentRuntimeAccess",
    "virtualSkills",
  ] satisfies Inject<Pick<HypernodeServices, Dependencies>>;

  declare protected ctx: HypernodeContext<Dependencies>;

  constructor(ctx: HypernodeContext<Dependencies>) {
    super(ctx, "transparentThreadActivation");
  }

  activate(request: TransparentThreadActivationRequest): TransparentThreadActivationDecision {
    const input = request.message.params?.["input"];
    const skillInput = inputItems(input);
    const explicitVirtualSkill = this.ctx.virtualSkills?.resolveInput(skillInput) ??
      (hasExplicitBuiltinVirtualSkill(skillInput) ? "builtin" : null);
    if (request.message.method === "turn/start" && explicitVirtualSkill !== null) {
      return "pass";
    }
    if (request.message.method === "turn/start" &&
        this.ctx.threadManager.isRoot(request.threadId) &&
        !this.ctx.administrator.hasAgent(request.connection)) {
      return "pass";
    }
    if (this.ctx.threadManager.isTransparentCodex(request.threadId)) return "ready";

    const thread = this.ctx.threadManager.find(request.threadId);
    const metadata = this.ctx.threadManager.metadataFor(request.threadId);
    const mayBindEngine = request.message.method === "thread/settings/update" ||
      request.message.method === "turn/start";
    const activatableKind = ACTIVATABLE_THREAD_KINDS.has(metadata?.kind ?? "");
    const requestedCwd = request.message.params?.["cwd"];
    let cwd = typeof requestedCwd === "string" ? requestedCwd : thread?.cwd;
    let filesystem = typeof cwd === "string"
      ? this.ctx.transparentRuntimeAccess.filesystemForCwd(cwd)
      : null;
    if (mayBindEngine && activatableKind && thread && !filesystem &&
        this.ctx.runtimeWorkspace.enabled) {
      const previousCwd = cwd;
      thread.cwd = this.ctx.runtimeWorkspace.projectsRoot();
      this.ctx.runtimeWorkspace.bindMain(thread);
      this.ctx.threadManager.changed(thread.id);
      cwd = thread.cwd;
      filesystem = this.ctx.transparentRuntimeAccess.defaultFilesystem();
      console.info(
        `[transparent-codex] repaired unroutable conversation cwd=${String(previousCwd ?? "")} ` +
        `outer=${request.threadId} workspaceCwd=${cwd}`,
      );
    }
    if (!mayBindEngine || !activatableKind ||
        typeof cwd !== "string" || !filesystem ||
        !this.ctx.threadManager.promoteToTransparentCodex(request.threadId)) {
      return "pass";
    }
    console.info(
      `[transparent-codex] materialized engine binding outer=${request.threadId} cwd=${cwd}`,
    );
    return "ready";
  }
}
