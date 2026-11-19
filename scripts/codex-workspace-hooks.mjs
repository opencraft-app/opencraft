import { isAbsolute } from "node:path";
const legacy = {
  readWorkspaceArtifact: "readCodexWorkspaceArtifact",
  prepareWorkspaceArtifact: "prepareCodexWorkspaceArtifact",
  decorateNativeTransport: "decorateCodexNativeTransport",
  finalizeNativeCreation: "finalizeCodexNativeCreation",
  finalizeNativeResume: "finalizeCodexNativeResume",
  requiresWorkspaceResume: "requiresCodexWorkspaceResume",
  restoreProvisionalWorkspace: "restoreCodexProvisionalWorkspace",
};

/** Validate configuration without constructing an attachment or allocating compute. */
export function validateCodexWorkspaceHooks(composition) {
  if (composition.createCodexWorkspaceHooks !== undefined) {
    if (typeof composition.createCodexWorkspaceHooks !== "function")
      throw Error("Invalid Headless workspace hook factory");
    if (Object.values(legacy).some((key) => composition[key] !== undefined))
      throw Error("Workspace hook factory cannot share global Native hooks");
  }
  for (const key of Object.values(legacy)) {
    if (composition[key] !== undefined && typeof composition[key] !== "function")
      throw Error("Invalid Headless Native hook: " + key);
  }
}

/** Called INSIDE MachineIdentityTransport's physical adapter factory, not once
 * per Host. Returned closures belong to that adapter; the decorated transport
 * owns their disposal. Factory construction must not allocate remote resources. */
export function createCodexWorkspaceHooks(composition, hostId) {
  validateCodexWorkspaceHooks(composition);
  if (!composition.createCodexWorkspaceHooks)
    return Object.freeze(Object.fromEntries(Object.entries(legacy).map(([key, value]) => [key, composition[value]])));
  const hooks = composition.createCodexWorkspaceHooks(Object.freeze({ hostId }));
  if (
    !hooks ||
    typeof hooks !== "object" ||
    typeof hooks.then === "function" ||
    Object.keys(hooks).some((key) => !Object.hasOwn(legacy, key))
  )
    throw Error("Invalid physical workspace hooks");
  for (const key of Object.keys(legacy)) {
    if (
      ["restoreProvisionalWorkspace", "prepareWorkspaceArtifact", "readWorkspaceArtifact"].includes(key) &&
      hooks[key] === undefined
    )
      continue;
    if (typeof hooks[key] !== "function") throw Error("Incomplete physical workspace hooks: " + key);
  }
  // Snapshot prevents later mutation of a factory result from redirecting a
  // receipt to a different physical attachment.
  return Object.freeze(Object.fromEntries(Object.keys(legacy).map((key) => [key, hooks[key]])));
}

/** Private deployment configuration, never a public settings or RPC payload. */
export function configuredWorkspaceExecution(options, environment = process.env) {
  const socketPath = environment.OPENCRAFT_WORKSPACE_AUTHORITY_SOCKET;
  if (socketPath === undefined) return undefined;
  if (
    typeof socketPath !== "string" ||
    !isAbsolute(socketPath) ||
    socketPath === "/" ||
    socketPath.includes("\0") ||
    Buffer.byteLength(socketPath) > 103 ||
    typeof options.codexCoreEndpoint !== "string" ||
    !options.codexCoreEndpoint ||
    typeof options.codexCoreAuthToken !== "string" ||
    options.codexCoreAuthToken.length < 32
  )
    throw Error("Workspace routing requires matched private Core configuration");
  return Object.freeze({ socketPath, token: options.codexCoreAuthToken });
}
