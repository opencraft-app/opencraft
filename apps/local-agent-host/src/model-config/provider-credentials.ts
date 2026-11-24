// The account owner's provider credentials as a lease source: a configured,
// enabled provider the owner may forward to (provider-route.ts), with the
// credential its reference names. Runtime-neutral: reads the same repositories
// whatever stores they are opened on.
import type { ProviderCredential, ProviderCredentialSource } from "@opencraft/account-pool-host/credential-leases";
import type { ModelConfigurationRepository, ModelCredentialRepository } from "./repository.js";
import { providerRoute } from "./provider-route.js";

export function modelProviderCredentials(
  configuration: ModelConfigurationRepository,
  credentials: ModelCredentialRepository,
): ProviderCredentialSource {
  return {
    async resolve(providerId): Promise<ProviderCredential | null> {
      // The configuration and the credential are separate documents; never answer from a torn pair.
      for (let attempt = 0; attempt < 3; attempt++) {
        const stamp = await credentials.stamp();
        const doc = await configuration.read();
        const provider = doc.providers.find((candidate) => candidate.id === providerId);
        if (!provider?.enabled) return null;
        const route = providerRoute(provider);
        if (route.route !== "account" || !provider.credentialRef) return null;
        const credential = await credentials.resolve(provider.credentialRef);
        if (stamp !== (await credentials.stamp()) || doc.revision !== (await configuration.read()).revision) continue;
        if (!credential) return null;
        return { providerId: provider.id, protocol: provider.protocol, baseUrl: route.baseUrl, credential };
      }
      return null;
    },
  };
}
