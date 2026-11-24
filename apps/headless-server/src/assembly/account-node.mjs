import { join } from "node:path";
import {
  configuredModelGatewayPath,
  modelGatewayStoreHolder,
  ModelGatewayStore,
  CodexCoreControlClient,
} from "@opencraft/account-pool-host";
import { codexCorePersonalSubscriptions } from "@opencraft/account-pool-host/personal-subscriptions";
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
 *   Codex Core control socket), read when the Web server is built. The file
 *   is opened by the first gateway request (as before, where each request
 *   opened it), then kept open by the account until the account closes, after
 *   the Web server stopped; the Codex Core, engines and sponsors still open
 *   the same file per call in their own processes, with the same busy timeout.
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
    modelGateway() {
      const gatewayPath = configuredModelGatewayPath();
      if (!gatewayPath) return null;
      return {
        store: modelGatewayStoreHolder(() => new ModelGatewayStore(gatewayPath)),
        subscriptions:
          codexCoreEndpoint && codexCoreAuthToken
            ? codexCorePersonalSubscriptions(new CodexCoreControlClient(codexCoreEndpoint, codexCoreAuthToken))
            : null,
      };
    },
  };
}
