import { Service, type Inject } from "@deepseek-ai/cordis";
import type { HypernodeContext, HypernodeServices } from "../types/context.ts";
import type {
  TransparentProtocolMapperPort,
  TransparentProtocolRuntimeState,
} from "../types/transparent-protocol-mapper.ts";
import type { RuntimeFilesystemPort } from "../types/workspace.ts";
import { cloudThreadName } from "./thread-identity.ts";
import { deepMap } from "./transparent-thread-routing.ts";

type MapperContext = HypernodeContext<"threadManager" | "transparentThreadBinding">;

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * Projects between the stable public AppServer namespace and one replaceable
 * execution Runtime namespace. This service is intentionally transport- and
 * engine-neutral: SSH, direct WebSocket, Codex and DSH all share the same
 * public identity rules.
 */
export class TransparentProtocolMapperService extends Service
  implements TransparentProtocolMapperPort {
  static inject = ["threadManager", "transparentThreadBinding"] satisfies Inject<Pick<
    HypernodeServices,
    "threadManager" | "transparentThreadBinding"
  >>;

  declare protected ctx: MapperContext;

  constructor(ctx: MapperContext) {
    super(ctx, "transparentProtocolMapper");
  }

  outerThreadId(
    innerThreadId: string,
    state?: TransparentProtocolRuntimeState | null,
  ): string | null {
    const outerThreadId = this.ctx.transparentThreadBinding.reverseBindings.get(innerThreadId);
    if (!outerThreadId) return null;
    const runtimeHint = this.ctx.transparentThreadBinding.runtimeHintFor(outerThreadId);
    if (runtimeHint?.backendKey && state && runtimeHint.backendKey !== state.backendKey &&
        !state.opening?.has(outerThreadId)) return null;
    return outerThreadId;
  }

  toInner(
    message: unknown,
    state: TransparentProtocolRuntimeState | null | undefined,
    filesystem: RuntimeFilesystemPort,
  ): unknown {
    return deepMap(message, (value) => {
      const binding = this.ctx.transparentThreadBinding.bindings.get(value);
      const runtimeHint = this.ctx.transparentThreadBinding.runtimeHintFor(value);
      if (binding && (!runtimeHint?.backendKey || runtimeHint.backendKey === state?.backendKey)) {
        return binding.innerThreadId;
      }
      return filesystem.owns(value) ? this.toPhysical(value, state, filesystem) : value;
    });
  }

  toOuter(
    message: unknown,
    state: TransparentProtocolRuntimeState | null | undefined,
    filesystem: RuntimeFilesystemPort,
  ): unknown {
    const mapped = deepMap(message, (value) => (
      this.outerThreadId(value, state) ?? this.toVirtual(value, state, filesystem)
    ));
    return this.enforceThreadNames(mapped);
  }

  toPhysical(
    path: string,
    state: TransparentProtocolRuntimeState | null | undefined,
    filesystem: RuntimeFilesystemPort,
  ): string {
    return filesystem.toPhysical(path, state?.user, state?.viewId);
  }

  toVirtual(
    path: string,
    state: TransparentProtocolRuntimeState | null | undefined,
    filesystem: RuntimeFilesystemPort,
  ): string {
    return filesystem.toVirtual(path, state?.user, state?.viewId);
  }

  enforceThreadNames(value: unknown): unknown {
    if (Array.isArray(value)) return value.map((item) => this.enforceThreadNames(item));
    if (value === null || typeof value !== "object") return value;
    const mapped: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      mapped[key] = this.enforceThreadNames(item);
    }
    const threadId = stringValue(mapped["id"]);
    const thread = threadId ? this.ctx.threadManager.find(threadId) : null;
    if (thread && this.ctx.threadManager.isTransparentCodex(thread.id) &&
        Object.prototype.hasOwnProperty.call(mapped, "name")) {
      mapped["name"] = cloudThreadName(thread.name, thread.preview);
    }
    return mapped;
  }
}
