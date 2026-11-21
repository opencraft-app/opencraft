import { pathToFileURL } from "node:url";
import { verifyRemoteBrowserArtifact } from "./remote-browser-artifact.mjs";
import { verifyElectronDistribution } from "./electron-distribution.mjs";

const targets = {
  "linux-x64": { platform: "linux", arch: "x64" },
  "windows-x64": { platform: "win32", arch: "x64" },
  "macos-arm64": { platform: "darwin", arch: "arm64" },
  "macos-x64": { platform: "darwin", arch: "x64" },
};

export async function verifyOwnedElectronArtifact(kind, target, distribution, forkDefinition) {
  if (!Object.hasOwn(targets, target) || !distribution || !forkDefinition)
    throw new Error("Invalid artifact target or paths");
  if (kind === "browser") {
    if (target !== "linux-x64" || process.platform !== "linux" || process.arch !== "x64")
      throw new Error("Browser artifact requires a matching Linux x64 runner");
    return verifyRemoteBrowserArtifact(distribution, forkDefinition);
  }
  if (kind === "desktop") return verifyElectronDistribution(distribution, forkDefinition, targets[target]);
  throw new Error("Invalid artifact kind");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await verifyOwnedElectronArtifact(...process.argv.slice(2));
}
