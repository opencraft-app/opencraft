export const REGISTRY_WRITES = ["register", "ready", "activate", "acceptCreation", "markSent", "rejectUnsent", "resolveCreation", "resolveRejectedCreation", "discover", "fenceRetirement", "retire", "replaceRetired", "selectAppPayload", "applyAppPayload", "beginRevoke", "finishRevoke", "discard", "setMetadata", "updateMetadata", "markNonpersistent", "runtimeChanged", "importHandoff", "selectRetention", "compareMetadata", "coldSnapshot", "close"] as const;

/** Rejections known to precede effects or to have completed a successful rollback. */
export class RegistryOperationRejected extends Error {
  constructor(message: string, readonly code = "GENERATION_REGISTRY_REJECTED") { super(message); this.name="RegistryOperationRejected"; }
}
export const REGISTRY_PENDING_LIMIT = 128;
