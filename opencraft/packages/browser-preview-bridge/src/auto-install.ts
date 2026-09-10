import { installPreviewBridgeRuntime } from "./runtime";

const runtimeKey = Symbol.for("vela.preview-bridge.runtime");
const runtimeHost = window as unknown as Window & Record<PropertyKey, unknown>;

if (window.parent !== window && runtimeHost[runtimeKey] === undefined) {
  runtimeHost[runtimeKey] = installPreviewBridgeRuntime({ window });
}
