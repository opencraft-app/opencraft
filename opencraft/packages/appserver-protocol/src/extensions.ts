/** Host-owned queue behavior that cannot be inferred from queue contents. */
export const OPENCRAFT_THREAD_QUEUE_EXTENSION = "opencraft/thread-queue";

export interface OpenCraftThreadQueueCapability {
  /** V2 makes queue-to-active-Turn consumption one AppServer command. */
  readonly version: 2;
  /** False for runtimes such as DSH whose inbox order is an invariant. */
  readonly reorder: boolean;
  readonly atomicSteer: true;
  /** Whether pause reasons are durable queue-item state rather than UI state. */
  readonly perItemPause: boolean;
}

/**
 * Host extension for catalogs whose contents are owned by a Thread/session.
 *
 * Codex catalogs are normally Host-wide. Runtimes such as Hermes can attach a
 * different provider configuration to each profile and live session, so a
 * model picker must name the Thread whose catalog it is requesting.
 */
export const OPENCRAFT_SCOPED_MODEL_CATALOG_EXTENSION =
  "opencraft/scoped-model-catalog";

export const OPENCRAFT_SCOPED_MODEL_CATALOG_CAPABILITY = Object.freeze({
  version: 1,
});
