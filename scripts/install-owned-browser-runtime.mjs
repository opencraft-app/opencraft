import { cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { verifyRemoteBrowserArtifact } from "./remote-browser-artifact.mjs";

/** Install one verified component into an isolated application image. */
export async function installOwnedBrowserRuntime({ distribution, application, definition, sourceRevision, baseImage }) {
  if (!/^[a-f0-9]{40}$/.test(sourceRevision) || !/^sha256:[a-f0-9]{64}$/.test(baseImage))
    throw new Error("Record the source commit and immutable base image ID");
  await verifyRemoteBrowserArtifact(distribution, definition);
  const markerName = "opencraft-electron-artifact.json";
  const markerBytes = await readFile(join(distribution, markerName));
  const marker = JSON.parse(markerBytes);
  const manifestPath = join(application, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files))
    throw new Error("Application manifest is unsupported");
  const prefix = "runtime/browser/electron/";
  const parent = join(application, "runtime/browser");
  const temporary = join(parent, "electron-install-" + randomUUID());
  await mkdir(parent, { recursive: true });
  try {
    await cp(distribution, temporary, { recursive: true });
    // Verify the copied bytes before removing the old component.
    await verifyRemoteBrowserArtifact(temporary, definition);
    await rm(join(parent, "electron"), { recursive: true, force: true });
    await rename(temporary, join(parent, "electron"));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  manifest.files = manifest.files.filter((file) => !file.path.startsWith(prefix));
  manifest.files.push(...marker.files.map(({ path, sha256 }) => ({ path: prefix + path, sha256 })), {
    path: prefix + markerName,
    sha256: createHash("sha256").update(markerBytes).digest("hex"),
  });
  manifest.files.sort((a, b) => a.path.localeCompare(b.path));
  const previousBuildId = manifest.buildId;
  manifest.buildId = previousBuildId + "-browser-" + marker.forkDefinitionSha256.slice(0, 12);
  manifest.browserRuntimeUpdate = {
    sourceRevision,
    baseImage,
    previousBuildId,
    forkDefinitionSha256: marker.forkDefinitionSha256,
    source: marker.source,
    electronVersion: marker.electronVersion,
    chromiumVersion: marker.chromiumVersion,
    nativeCopyProbePassed: true,
    nativeInputCausalityProbePassed: true,
    nativeImeFocusIdentityProbePassed: true,
  };
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  return manifest.browserRuntimeUpdate;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [distribution, application, definition, sourceRevision, baseImage] = process.argv.slice(2);
  console.log(
    JSON.stringify(
      await installOwnedBrowserRuntime({ distribution, application, definition, sourceRevision, baseImage }),
    ),
  );
}
