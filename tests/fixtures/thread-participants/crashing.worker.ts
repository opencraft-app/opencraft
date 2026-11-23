import { serveWorkerOwner } from "../../../packages/worker-owner/src/serve.ts";
import { openParticipantStore } from "../../../plugins/thread-participants/src/participant-store.ts";
import type { ParticipantStoreData } from "../../../plugins/thread-participants/src/store-protocol.ts";

/** The real participant owner, except that the Worker dies on its first write. */
serveWorkerOwner((data: ParticipantStoreData) => {
  const owner = openParticipantStore(data);
  return { ...owner, methods: { ...owner.methods, apply: () => process.exit(70) } };
});
