/** Cache budgets exclude active tasks, interactions, consumers and durable drafts.
 * Byte budgets estimate serialized content; they are not JavaScript heap limits.
 * The class describes device capacity, never touch presentation. */
export type WorkbenchResourceClass = "standard" | "constrained";

export const WORKBENCH_RESOURCE_POLICIES: Readonly<Record<WorkbenchResourceClass, Readonly<{
  maxInactiveThreads: number; maxInactiveThreadBytes: number; maxCachedThreadMetadata: number; maxInactiveViews: number; maxInactiveScopes: number;
}>>> = Object.freeze({
  standard: Object.freeze({ maxInactiveThreads: 4, maxInactiveThreadBytes: 64 * 1024 * 1024,
    maxCachedThreadMetadata: 128, maxInactiveViews: 20, maxInactiveScopes: 20 }),
  constrained: Object.freeze({ maxInactiveThreads: 1, maxInactiveThreadBytes: 8 * 1024 * 1024,
    maxCachedThreadMetadata: 32, maxInactiveViews: 4, maxInactiveScopes: 4 }),
});
