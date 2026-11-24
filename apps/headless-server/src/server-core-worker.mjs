// The Headless Server owner Worker: the installation (writer lock, migrations,
// import) and the domain services already moved off the network thread run
// here on the owner connection. The network thread calls them through
// `openServerCoreOwner(...).call` (docs/architecture/server/server-core-owner.md).
import { serveServerCoreOwner } from "@opencraft/storage-node/server-owner-serve";
import { ModelGatewayStore } from "@opencraft/account-pool-host";
import { projectModelCatalog } from "@opencraft/model-usage-policy/transport";
import { sharedMemoryCommitFence } from "@opencraft/access-control/commit-fence/shared-memory";
import { installCommunicationExtension } from "@opencraft/access-control/communication-extension";
import { workerData } from "node:worker_threads";
import { serverCoreDomains } from "./server-core-domains.mjs";

// The network thread's communication extension, as the standalone orchestration
// Worker installed it. Trusted parent-owned data; no request selects the module.
const extensionModule = workerData?.data?.communicationExtensionModule;
if (typeof extensionModule === "string") installCommunicationExtension((await import(extensionModule)).communicationExtension);

serveServerCoreOwner((owner, data) => {
  // The commit fence lets the network thread recheck Actor administration under
  // this writer lock; the shared buffer crosses to this Worker as data.
  const domains = serverCoreDomains(owner, {
    identityFence: data.identityFence ? sharedMemoryCommitFence(data.identityFence) : undefined,
  });
  return {
    methods: {
      ...domains.methods,
      // Node-only: both catalogs read a policy or gateway database by path.
      projectModelCatalog,
      filterGatewayModelCatalog: (path, actorId, models) => {
        const gateway = new ModelGatewayStore(path);
        try {
          return models.filter((model) => {
            const id = typeof model?.model === "string" && model.model ? model.model : model?.id;
            if (typeof id !== "string" || !id.startsWith("configured/")) return true;
            try {
              return gateway.canUse(decodeURIComponent(id.slice("configured/".length).split("/")[0]), actorId);
            } catch {
              return false;
            }
          });
        } finally {
          gateway.close();
        }
      },
    },
    close: domains.close,
  };
});
