import { matchesGlob } from "node:path";

/** Match declared workspace owners, not an assumed apps/packages depth. */
export function selectWorkspaceManifests(patterns, trackedFiles) {
  return [...new Set(trackedFiles.filter(file => file && patterns.some(pattern =>
    matchesGlob(file, `${pattern}/package.json`))))].sort();
}
