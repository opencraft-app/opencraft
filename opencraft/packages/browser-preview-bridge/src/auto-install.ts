import { installPreviewBridgeRuntime } from "./runtime";
// Standard Electron guests use the same sandboxed, typed DOM protocol.
// Exporting the bridge does not expose any Node or application capability.
export { installPreviewBridgeRuntime } from "./runtime";
export { PreviewBridgeAdapter } from "./adapter";

const runtimeKey = Symbol.for("vela.preview-bridge.runtime");
const runtimeHost = window as unknown as Window & Record<PropertyKey, unknown>;

if (window.parent !== window && runtimeHost[runtimeKey] === undefined) {
  runtimeHost[runtimeKey] = installPreviewBridgeRuntime({ window });
}
