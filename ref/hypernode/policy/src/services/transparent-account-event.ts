import { Service, type Context } from "@deepseek-ai/cordis";
import type { JsonRpcResponse } from "../types/appserver.ts";
import type {
  TransparentAccountEventListener,
  TransparentAccountEventPort,
} from "../types/transparent-account.ts";
import type { TransparentBackendState } from "../types/transparent-backend.ts";
import { accountUpdatedBindingState } from "./transparent-thread-routing.ts";

/** Projects Codex account notifications into the per-SSH-user device identity. */
export class TransparentAccountEventService extends Service
  implements TransparentAccountEventPort {
  static readonly inject = ["deviceIdentity"];
  private listeners: Set<TransparentAccountEventListener> | undefined;

  constructor(ctx: Context) {
    super(ctx, "transparentAccountEvent");
    this.listeners = new Set();
  }

  on(listener: TransparentAccountEventListener): () => void {
    this.listeners ??= new Set();
    this.listeners.add(listener);
    return () => this.listeners?.delete(listener);
  }

  emit(
    ownerUserId: string,
    message: JsonRpcResponse,
    state: TransparentBackendState,
  ): void {
    this.listeners ??= new Set();
    for (const listener of this.listeners) listener(ownerUserId, message, state);
  }

  handle(
    ownerUserId: string,
    message: JsonRpcResponse,
    emit: (message: JsonRpcResponse) => void,
  ): boolean {
    if (message.method === "account/login/completed") {
      if (loginSucceeded(message.params)) {
        this.ctx.deviceIdentity.setBindingState(ownerUserId, "bound");
      }
      emit(message);
      return true;
    }
    if (message.method !== "account/updated") return false;
    this.ctx.deviceIdentity.setBindingState(
      ownerUserId,
      accountUpdatedBindingState(message.params),
    );
    emit(message);
    return true;
  }
}

function loginSucceeded(params: unknown): boolean {
  return typeof params === "object" && params !== null &&
    Reflect.get(params, "success") === true;
}
