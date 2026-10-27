import { copyDependencyClosure } from './full-release/closure.mjs';
/** Preserve Node resolution, including nested versions and optional native deps. */
export const copyServerRuntime = (destination, roots, { resolver, installationRoot } = {}) =>
  copyDependencyClosure(destination, roots, resolver, installationRoot);
export const copyMcpAppRuntime = destination => copyServerRuntime(destination, ["quickjs-emscripten-core", "@jitl/quickjs-wasmfile-release-sync"]);
export const copyPiRuntime = destination => copyServerRuntime(destination, ["@earendil-works/pi-coding-agent", "@earendil-works/pi-durable", "@earendil-works/pi-ai", "@earendil-works/chord"]);
export const copyPiShellRuntime = destination => copyServerRuntime(destination, ["pi-interactive-shell", "@earendil-works/pi-tui"]);

export const copyAllServerRuntime = destination => copyServerRuntime(destination, [
  "quickjs-emscripten-core", "@jitl/quickjs-wasmfile-release-sync",
  "@earendil-works/pi-coding-agent", "@earendil-works/pi-durable", "@earendil-works/pi-ai", "@earendil-works/chord",
  "pi-interactive-shell", "@earendil-works/pi-tui",
]);
