// The Headless Server owner Worker: the installation (writer lock, migrations,
// import) and the domain services already moved off the network thread run
// here on the owner connection. The network thread calls them through
// `openServerCoreOwner(...).call` (docs/architecture/server/server-core-owner.md).
import { serveServerCoreOwner } from "@opencraft/storage-node/server-owner-serve";
import { ThreadNoteStore } from "@opencraft/plugin-thread-summary/note-store";
import { CapabilityBindings } from "@opencraft/session-capabilities/bindings";

serveServerCoreOwner((owner) => {
  const notes = new ThreadNoteStore(owner);
  const capabilityBindings = new CapabilityBindings(owner);
  return {
    methods: {
      /** Merges a shared note update; access was checked on the network thread. */
      exchangeThreadNote: (serverId, threadId, update, vector) => notes.exchange(serverId, threadId, update, vector),
      /** Every capability binding, loaded once into the network thread's projection. */
      capabilityBindings: () => capabilityBindings.snapshot(),
      /** Commits one write the projection already checked and applied. */
      applyCapabilityBinding: (write) => capabilityBindings.apply(write),
    },
    close: () => {
      try {
        capabilityBindings.close();
      } finally {
        notes.close();
      }
    },
  };
});
