import { join } from "node:path";
import { resourceId } from "../../domain/bot-binding.mjs";
import { digest } from "../../domain/values.mjs";

export const isBotProfile = (profile) => profile.config.layout === "bot-v1";
/** Engine sessions outlive execution attempts. Preserve the original path for legacy profiles. */
export function codexSessionRoot(profile, sessionRoot) {
  return join(profile.path, isBotProfile(profile) ? "engines" : "executions", "codex", digest(sessionRoot));
}
export function piSessionPath(profile, workId) {
  resourceId(workId, "work ID");
  return isBotProfile(profile)
    ? join(profile.path, "engines", "pi", `${workId}.sqlite`)
    : join(profile.path, "executions", `${workId}.sqlite`);
}
export function executionWorkspace(profile, executionId) {
  return join(profile.path, "executions", resourceId(executionId, "execution ID"));
}
