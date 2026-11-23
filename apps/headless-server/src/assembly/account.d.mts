import type { IncomingMessage, ServerResponse } from "node:http";
import type { ModelPolicyStore } from "@opencraft/model-usage-policy";

export interface AccountHttpAuthorities {
  /** Actor authentication for the model gateway; the Actor must be a Human. */
  actorAccess: {
    authenticate(request: IncomingMessage): { actorId: string } | null | undefined;
    options: { trustedOrigin?(request: IncomingMessage): string | null | undefined };
  };
  actorStore: { get(actorId: string): { kind: string } | null | undefined };
  /** Instance admission; absent when the deployment has no membership. */
  instanceAccess?: {
    authenticate(request: IncomingMessage): { provider: string; subject: string } | null | undefined;
    role(principal: { provider: string; subject: string }): string | null | undefined;
    trustedOrigin(request: IncomingMessage): string | null;
  } | null;
}

export interface AccountAssembly {
  readonly modelPolicyPath: string;
  /** The only writer of `model-usage-policy.sqlite`. */
  readonly modelPolicy: ModelPolicyStore;
  /** Model gateway and model policy routes; resolves false when the request is for neither. */
  createHttpService(
    authorities: AccountHttpAuthorities,
  ): (request: IncomingMessage, response: ServerResponse) => Promise<boolean>;
  /** A new speech transcription service; the Web server closes it with itself. */
  createSpeechService(): { close(): void };
  /** Closes the policy writer; the composition root calls it before releasing its writer lock. */
  close(): void;
}

export function assembleAccount(options: {
  dataDirectory: string;
  codexCoreEndpoint?: string;
  codexCoreAuthToken?: string;
}): AccountAssembly;
