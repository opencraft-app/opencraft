import { ModelPolicyStore } from "@opencraft/model-usage-policy/store";
import { modelPolicyHttp } from "@opencraft/model-usage-policy/http";
import {
  ModelConfigurationRepository,
  ModelCredentialRepository,
} from "@opencraft/local-agent-host/model-config/repository";
import { modelProviderCredentials } from "@opencraft/local-agent-host/model-config/provider-credentials";
import { SpeechModelConfiguration } from "@opencraft/local-agent-host/model-config/speech";
import { documentCredentialLeases } from "@opencraft/account-pool-host/credential-leases";
import { SpeechTranscriptionService } from "../speech-transcription-service.mjs";
import { accountRoute, installationAccountAuthorities } from "../account-routes.ts";

/**
 * Account assembly: the deployment's model usage policy, model configuration
 * and credentials, short-lived credential leases, the model gateway settings
 * with personal subscriptions, and speech transcription.
 *
 * Runtime-neutral: every store arrives as a port. The Node root passes the
 * data directory's files (account-node.mjs); the AccountCore Durable Object
 * passes its own storage (cloudflare/account-core.ts). The policy database is
 * opened when this is called; the composition root calls `close` at the policy
 * writer's position in its shutdown order.
 */
export function assembleAccount({ openModelPolicy, modelDocuments, modelSecrets, modelGateway }) {
  const modelConfiguration = new ModelConfigurationRepository(modelDocuments);
  const modelCredentials = new ModelCredentialRepository(modelSecrets);
  const modelPolicy = new ModelPolicyStore(openModelPolicy());
  const credentialLeases = documentCredentialLeases(
    modelDocuments,
    modelProviderCredentials(modelConfiguration, modelCredentials),
  );
  /** The account's routes over the given authorities; dispatched by the shared route table. */
  function createAccountHttpService(authorities) {
    const gateway = modelGateway?.(authorities.gateway) ?? null;
    const policy = modelPolicyHttp(modelPolicy, authorities.policy);
    return async (exchange) => {
      const service = accountRoute(new URL(exchange.path, "http://account.invalid").pathname);
      if (service === "gateway") return gateway ? await gateway(exchange) : null;
      if (service === "policy") return await policy(exchange);
      return null;
    };
  }
  return {
    modelPolicy,
    modelConfiguration,
    modelCredentials,
    credentialLeases,
    createAccountHttpService,
    /** The Node gateway's form: authorities from the installation's services beside it. */
    createHttpService(services) {
      return createAccountHttpService(installationAccountAuthorities(services));
    },
    /** The Web server owns the returned service and closes it with itself. */
    createSpeechService() {
      return new SpeechTranscriptionService({
        configuration: new SpeechModelConfiguration(modelConfiguration, modelCredentials),
      });
    },
    close() {
      modelPolicy.close();
    },
  };
}
