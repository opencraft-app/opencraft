import { join } from "node:path";
import { configuredModelGatewayPath, modelGatewayHttp, CodexCoreControlClient } from "@opencraft/account-pool-host";
import { gatewayContributions } from "@opencraft/local-agent-host/model-config";
import { fileStateDocumentStore } from "@opencraft/document-storage/state-file";
import { fileSecretStore } from "@opencraft/secret-storage/file";
import { openModelPolicyDatabase } from "@opencraft/model-usage-policy";

/**
 * The Node root's account inputs (account.mjs): the data directory's files,
 * opened at the same moments as before the account module took ports.
 * - `model-usage-policy.sqlite` at the data directory root, opened by the
 *   managed SQLite lifecycle when the account is assembled;
 * - `models/` for model configuration, credentials (private 0600 files) and
 *   credential leases;
 * - the model gateway (its own SQLite file, named by
 *   OPENCRAFT_MODEL_GATEWAY_DATABASE, and personal subscriptions through the
 *   Codex Core control socket), read when the Web server is built.
 */
export function nodeAccountInputs({ dataDirectory, codexCoreEndpoint, codexCoreAuthToken }) {
  const modelPolicyPath = join(dataDirectory, "model-usage-policy.sqlite");
  const models = join(dataDirectory, "models");
  return {
    /** Engines and Hosts on this machine read the policy file directly (native.mjs). */
    modelPolicyPath,
    openModelPolicy: () => openModelPolicyDatabase(modelPolicyPath),
    modelDocuments: fileStateDocumentStore(models),
    modelSecrets: fileSecretStore(models),
    modelGateway(authority) {
      const gatewayPath = configuredModelGatewayPath();
      if (!gatewayPath) return null;
      const contributions = gatewayContributions(models, gatewayPath);
      const subscriptionCore =
        codexCoreEndpoint && codexCoreAuthToken ? new CodexCoreControlClient(codexCoreEndpoint, codexCoreAuthToken) : null;
      return modelGatewayHttp({
        path: gatewayPath,
        ...contributions,
        subscription: subscriptionCore
          ? async (actor, input, assertCurrent) => {
              assertCurrent();
              const result = await subscriptionCore.accountRequest("opencraft/codex/accounts/personal/" + input.operation, {
                actor,
                sessionId: input.sessionId,
              });
              assertCurrent();
              if (result.status === "complete")
                return {
                  status: "complete",
                  ...(await contributions.connectSubscription(actor, result.connection, assertCurrent)),
                };
              return result;
            }
          : undefined,
        authority,
      });
    },
  };
}
