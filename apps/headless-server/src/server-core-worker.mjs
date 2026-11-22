// The Headless Server owner Worker: the installation (writer lock, migrations,
// import) and the domain services already moved off the network thread run
// here on the owner connection. The network thread calls them through
// `openServerCoreOwner(...).call` (docs/architecture/server/server-core-owner.md).
import { serveServerCoreOwner } from "@opencraft/storage-node/server-owner-serve";
import { ThreadNoteStore } from "@opencraft/plugin-thread-summary/note-store";

serveServerCoreOwner((owner) => {
  const notes = new ThreadNoteStore(owner);
  return {
    methods: {
      /** Merges a shared note update; access was checked on the network thread. */
      exchangeThreadNote: (serverId, threadId, update, vector) => notes.exchange(serverId, threadId, update, vector),
    },
    close: () => notes.close(),
  };
});
