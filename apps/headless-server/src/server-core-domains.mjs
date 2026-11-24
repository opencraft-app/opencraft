// The domain services a Server core owner serves on its own connection,
// whatever runs the owner (runtime-neutral): the Node owner Worker
// (server-core-worker.mjs, through serveServerCoreOwner) and an owner on the
// authorizer's own thread (the InstallationCore Durable Object, through
// assembly/server-core-same-thread.ts). One composition, so both owners serve
// the same methods with the same semantics
// (docs/architecture/server/server-core-owner.md). Methods that read Node
// files by path (the model policy and gateway catalogs) stay in the Node owner
// Worker.
import { ThreadNoteStore } from "@opencraft/plugin-thread-summary/note-store";
import { CapabilityBindings } from "@opencraft/session-capabilities/bindings";
import { IdentityWriteOwner, identityWriteMethods } from "@opencraft/access-control/identity-writes";
import { localAccountPasswordUpgrade } from "@opencraft/access-control/local-account-upgrade-owner";
import { orchestrationRuntimeOwnerMethods } from "@opencraft/access-control/orchestration-runtime-domain";
import { serverSpacesOwnerMethods } from "@opencraft/access-control/server-spaces-domain";

/**
 * Builds the core domains over the owner's migrated database. `identityFence`
 * is the owner side of the identity commit fence (`CommitFence`), or
 * undefined when no authorizer rechecks identity writes.
 */
export function serverCoreDomains(owner, { identityFence } = {}) {
  const notes = new ThreadNoteStore(owner);
  const capabilityBindings = new CapabilityBindings(owner);
  // The commit fence lets the authorizer recheck Actor administration under
  // this writer before commit.
  const identity = new IdentityWriteOwner(owner, identityFence, {
    upgradeLocalPassword: localAccountPasswordUpgrade(owner.database),
  });
  // Orchestration runtime, communication and automation ledgers, and the Server
  // space ledger: one writer on this connection, in FIFO with every domain here.
  const orchestration = orchestrationRuntimeOwnerMethods(owner);
  const spaces = serverSpacesOwnerMethods(owner);
  const readConversationOwner = owner.database.prepare(
    "SELECT server_id AS serverId, owner_actor_id AS ownerActorId FROM opencraft_thread_relations WHERE thread_id=?",
  );
  return {
    methods: {
      // Login sessions, identity bindings and Actor administration (IdentityWrites).
      ...identityWriteMethods(identity),
      ...orchestration.methods,
      ...spaces.methods,
      /** Merges a shared note update; access was checked on the network thread. */
      exchangeThreadNote: (serverId, threadId, update, vector) => notes.exchange(serverId, threadId, update, vector),
      /** Every capability binding, loaded once into the network thread's projection. */
      capabilityBindings: () => capabilityBindings.snapshot(),
      /** Commits one write the projection already checked and applied. */
      applyCapabilityBinding: (write) => capabilityBindings.apply(write),
      readConversationOwner: (threadId) => readConversationOwner.get(threadId) ?? null,
    },
    close: async () => {
      try {
        await orchestration.close();
      } finally {
        try {
          identity.close();
        } finally {
          try {
            capabilityBindings.close();
          } finally {
            notes.close();
          }
        }
      }
    },
  };
}
