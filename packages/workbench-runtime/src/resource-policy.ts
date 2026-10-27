/** Cache budgets exclude active tasks, interactions, consumers and durable drafts.
 * Byte budgets estimate serialized content; they are not JavaScript heap limits. */
export const WORKBENCH_RESOURCE_POLICIES = Object.freeze({
  desktop: Object.freeze({ maxInactiveThreads: 4, maxInactiveThreadBytes: 64 * 1024 * 1024,
    maxCachedThreadMetadata: 128, maxInactiveViews: 20, maxInactiveScopes: 20 }),
  mobile: Object.freeze({ maxInactiveThreads: 1, maxInactiveThreadBytes: 8 * 1024 * 1024,
    maxCachedThreadMetadata: 32, maxInactiveViews: 4, maxInactiveScopes: 4 }),
});
