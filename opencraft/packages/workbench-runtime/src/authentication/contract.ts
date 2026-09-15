/** Session truth comes from the provider, never from a profile/catalog fetch. No credentials cross this port. */
export interface AuthenticationSession {
  readonly status: "anonymous" | "authenticated";
  readonly epoch: number;
}

export type AuthenticationResult =
  | { readonly status: "authenticated"; readonly epoch: number }
  | { readonly status: "cancelled" }
  | { readonly status: "redirecting" };

export interface AuthenticationProvider {
  readonly id: string;
  getSession(): AuthenticationSession;
  subscribe(listener: () => void): () => void;
  signIn(optionId?: string): Promise<AuthenticationResult>;
  cancelSignIn(): Promise<void>;
}

export const AUTHENTICATION_PROVIDER_CHANNEL = "authenticationProvider";

export interface AuthenticationFlowRequest {
  /** Opaque provider-owned option (e.g. account site), never an arbitrary URL. */
  readonly optionId?: string;
  readonly providerId: string;
  /** A feature-owned lease, not a Host identity or a redirect URL. */
  readonly owner: string;
  readonly reason: "account-entry" | "environment-create" | "account-settings" | "host-access";
  readonly presentation: "dialog" | "inline" | "menu";
}

export interface AuthenticationFlow extends AuthenticationFlowRequest {
  readonly id: string;
  readonly phase: "ready" | "pending" | "error";
  readonly error: string | null;
}

export type AuthenticationFlowResult = AuthenticationResult | { readonly status: "abandoned" } | { readonly status: "error" };

/** Narrow capability exposed to Views. It cannot set sessions, navigate or provision resources. */
export interface AuthenticationFlowPort {
  getSnapshot(): AuthenticationFlow | null;
  subscribe(listener: () => void): () => void;
  open(request: AuthenticationFlowRequest): string;
  submit(id: string): Promise<AuthenticationFlowResult>;
  cancel(id: string): void;
  abandon(id: string): void;
}
