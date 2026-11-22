import { access } from "node:fs/promises";
import { openAssetConfigurations } from "@opencraft/plugin-assets/server";
/** The Headless composition adds native lease reads to the same sole vault Worker. */
export async function openHeadlessAssetsStorage(directory: string, options: { installationFile?: string } = {}) {
  let entry = new URL("./assets-runtime-worker.mjs", import.meta.url);
  try {
    await access(entry);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    entry = new URL("./assets-runtime.worker.ts", import.meta.url);
  }
  return openAssetConfigurations(directory, {
    entry,
    ...(options.installationFile === undefined ? {} : { installationFile: options.installationFile }),
  });
}
