import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** Refuse a generic Web build before a headless package can claim a live Host. */
export async function assertHeadlessWebRelease(webRoot) {
  let release;
  try {
    release = JSON.parse(await readFile(join(webRoot, "version.json"), "utf8"));
  } catch (error) {
    throw new Error("Headless server requires valid Web release metadata", { cause: error });
  }
  if (release?.schemaVersion !== 1
    || typeof release.buildId !== "string"
    || release.headlessServer !== true
    || release.headlessHostId !== "opencraft-server") {
    throw new Error("Headless server requires a Web build with its Codex and opencraft-server Host entry enabled");
  }
  return release;
}
