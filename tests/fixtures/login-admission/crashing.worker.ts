import { serveWorkerOwner } from "../../../packages/worker-owner/src/serve.ts";
import { openLoginAdmissionStore } from "../../../plugins/login-admission/src/store.ts";
import type { LoginAdmissionStoreData } from "../../../plugins/login-admission/src/store-protocol.ts";

/** The real login admission owner, except that the Worker dies on its first identity write. */
serveWorkerOwner((data: LoginAdmissionStoreData) => {
  const owner = openLoginAdmissionStore(data);
  return { ...owner, methods: { ...owner.methods, recordIdentity: () => process.exit(70) } };
});
