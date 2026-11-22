/** Owner-local evidence only. Private Worker RPC exposes a generic unavailable
 * error, never provider diagnostics, paths or credentials. */
export class WorkspaceArtifactCleanupUnconfirmed extends Error {
  constructor() {
    super("Workspace artifact cleanup unconfirmed");
  }
}
