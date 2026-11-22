// The Headless Server owner Worker: the installation (writer lock, migrations,
// import) and the domain services already moved off the network thread run
// here on the owner connection. The network thread calls them through
// `openServerCoreOwner(...).call` (docs/architecture/server/server-core-owner.md).
import { serveServerCoreOwner } from "@opencraft/storage-node/server-owner-serve";
import { ThreadNoteStore } from "@opencraft/plugin-thread-summary/note-store";
import { ModelGatewayStore } from "@opencraft/account-pool-host";
import { projectModelCatalog } from "@opencraft/model-usage-policy/transport";
import { CapabilityBindings } from "@opencraft/session-capabilities/bindings";
import { IdentityWriteOwner, identityWriteMethods } from "@opencraft/access-control/identity-writes";

serveServerCoreOwner((owner, data) => {
  const notes = new ThreadNoteStore(owner);
  const capabilityBindings = new CapabilityBindings(owner);
  // The commit fence lets the network thread recheck Actor administration under this writer lock.
  const identity = new IdentityWriteOwner(owner, data.identityFence);
  const readConversationOwner = owner.database.prepare(
    "SELECT server_id AS serverId, owner_actor_id AS ownerActorId FROM opencraft_thread_relations WHERE thread_id=?",
  );
  return {
    methods: {
      // Login sessions, identity bindings and Actor administration (IdentityWrites).
      ...identityWriteMethods(identity),
      /** Merges a shared note update; access was checked on the network thread. */
      exchangeThreadNote: (serverId, threadId, update, vector) => notes.exchange(serverId, threadId, update, vector),
      /** Every capability binding, loaded once into the network thread's projection. */
      capabilityBindings: () => capabilityBindings.snapshot(),
      /** Commits one write the projection already checked and applied. */
      applyCapabilityBinding: (write) => capabilityBindings.apply(write),
      readConversationOwner: (threadId) => readConversationOwner.get(threadId) ?? null,
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
    close: () => {
      try {
        identity.close();
      } finally {
        try {
          capabilityBindings.close();
        } finally {
          notes.close();
        }
      }
    },
  };
});
