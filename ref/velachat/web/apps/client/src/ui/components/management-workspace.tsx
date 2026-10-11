/**
 * Stable public surface for management UI primitives.
 *
 * Implementations live in focused internal modules so callers keep one import
 * path while collection/detail/form concerns can evolve independently.
 */
export * from "./management-workspace-core";
export * from "./management-workspace-form";
export * from "./management-preference";
