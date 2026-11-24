import { join } from "node:path";
import { configuredModelGatewayPath, modelGatewayHttp, CodexCoreControlClient } from "@opencraft/account-pool-host";
import { gatewayContributions } from "@opencraft/local-agent-host/model-config";
import {
  ModelConfigurationRepository,
  ModelCredentialRepository,
} from "@opencraft/local-agent-host/model-config/repository";
import { SpeechModelConfiguration } from "@opencraft/local-agent-host/model-config/speech";
import { fileStateDocumentStore } from "@opencraft/document-storage/state-file";
import { fileSecretStore } from "@opencraft/secret-storage/file";
import { ModelPolicyStore } from "@opencraft/model-usage-policy";
import { modelPolicyHttp } from "@opencraft/model-usage-policy/http";
import { SpeechTranscriptionService } from "../speech-transcription-service.mjs";

/**
 * Account assembly: the deployment's model usage policy, the model gateway
 * settings with personal subscriptions, and speech transcription. It opens the
 * policy database when called; the composition root calls `close` at the
 * policy writer's position in its shutdown order.
 */
export function assembleAccount({ dataDirectory, codexCoreEndpoint, codexCoreAuthToken }) {
  const modelPolicyPath = join(dataDirectory, "model-usage-policy.sqlite");
  const modelPolicy = new ModelPolicyStore(modelPolicyPath);
  return {
    modelPolicyPath,
    modelPolicy,
    /** The gateway path and subscription client are read once, when the Web server is built. */
    createHttpService({ actorAccess, actorStore, instanceAccess }) {
      const gatewayPath = configuredModelGatewayPath();
      const contributions = gatewayPath ? gatewayContributions(join(dataDirectory, "models"), gatewayPath) : null;
      const subscriptionCore =
        codexCoreEndpoint && codexCoreAuthToken
          ? new CodexCoreControlClient(codexCoreEndpoint, codexCoreAuthToken)
          : null;
      const gateway = gatewayPath
        ? modelGatewayHttp({
            path: gatewayPath,
            ...contributions,
            subscription: subscriptionCore
              ? async (actor, input, assertCurrent) => {
                  assertCurrent();
                  const result = await subscriptionCore.accountRequest(
                    "opencraft/codex/accounts/personal/" + input.operation,
                    { actor, sessionId: input.sessionId },
                  );
                  assertCurrent();
                  if (result.status === "complete")
                    return {
                      status: "complete",
                      ...(await contributions.connectSubscription(actor, result.connection, assertCurrent)),
                    };
                  return result;
                }
              : undefined,
            authority: (request) => {
              const context = actorAccess.authenticate(request);
              if (!context || actorStore.get(context.actorId)?.kind !== "human") return null;
              const principal = instanceAccess?.authenticate(request);
              return {
                actor: context.actorId,
                administrator: !!principal && instanceAccess.role(principal) === "admin",
                origin: actorAccess.options.trustedOrigin?.(request) ?? null,
              };
            },
          })
        : null;
      const policy = modelPolicyHttp(modelPolicy, (request) => {
        const principal = instanceAccess?.authenticate(request);
        if (!principal || !instanceAccess.role(principal)) return null;
        return {
          actor: JSON.stringify([principal.provider, principal.subject]),
          administrator: instanceAccess.role(principal) === "admin",
          origin: instanceAccess.trustedOrigin(request),
        };
      });
      return async (request, response) =>
        (gateway && (await gateway(request, response))) || (await policy(request, response));
    },
    /** The Web server owns the returned service and closes it with itself. */
    createSpeechService() {
      return new SpeechTranscriptionService({
        configuration: new SpeechModelConfiguration(
          new ModelConfigurationRepository(fileStateDocumentStore(join(dataDirectory, "models"))),
          new ModelCredentialRepository(fileSecretStore(join(dataDirectory, "models"))),
        ),
      });
    },
    close() {
      modelPolicy.close();
    },
  };
}
