import type { InternalContributionAdapter } from "@opencraft/extension-runtime";
import type { AuthenticationProvider, AuthenticationService } from "@opencraft/workbench-runtime";

export function authenticationProviderAdapter(service: AuthenticationService): InternalContributionAdapter {
  return { prepare: (owner, value) => {
    const provider = value as Partial<AuthenticationProvider> | null;
    if (!provider || typeof provider.id !== "string" || !provider.id.trim()
      || typeof provider.getSession !== "function" || typeof provider.subscribe !== "function"
      || typeof provider.signIn !== "function" || typeof provider.cancelSignIn !== "function") {
      throw new TypeError("Invalid authentication provider");
    }
    return { commit: () => service.register(owner.activationId, provider as AuthenticationProvider) };
  } };
}
