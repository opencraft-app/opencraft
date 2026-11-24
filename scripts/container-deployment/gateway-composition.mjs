import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { openPackageVfs } from "@opencraft/runtime-plugin-host/package-vfs";
import { boundedFile, checkedDirectory } from "@opencraft/runtime-plugin-host/store";
import { prepareProductServerMigrations } from "@opencraft/storage-node/server-composition";
import { verifyExtensionFamilies } from "@opencraft/storage-node/server";
import {
  loadHeadlessExtensions,
  validateHeadlessExtensions,
} from "../../apps/headless-server/src/headless-extensions.mjs";
import { validateLoginAdmission } from "../../apps/headless-server/src/headless-identity.mjs";
import { validateCodexWorkspaceHooks } from "../../apps/headless-server/src/codex-workspace-hooks.mjs";
import { validateRuntimePluginOptions } from "../../apps/headless-server/src/runtime-plugins.mjs";

export const CHECK_GATEWAY_COMPOSITION = "--check-gateway-composition";
const entry = "composition.mjs";
const functions = new Set([
  "close",
  "createIdentity",
  "isHuman",
  "createChannelSync",
  "createChannelSyncs",
  "selectHostFiles",
  "selectHostTerminalService",
  "workspaceOutputIdentity",
  "createCodexWorkspaceHooks",
]);
const objects = new Set([
  "extensions",
  "runtimePlugins",
  "loginAdmission",
  "relayAssertionOptions",
  "channelSync",
  "personalAssistantHost",
  "serverMigrations",
]);
const plain = (value) =>
  value && typeof value === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(value));

export async function loadGatewayComposition(env = process.env) {
  const source = env.OPENCRAFT_GATEWAY_COMPOSITION_DIRECTORY;
  const sha256 = env.OPENCRAFT_GATEWAY_COMPOSITION_SHA256;
  if (source === undefined && sha256 === undefined) return undefined;
  if (!source || !isAbsolute(source) || resolve(source) !== source || source === "/" || sha256 === undefined)
    throw Error("Configure an absolute Gateway composition directory and its manifest SHA-256");
  await checkedDirectory(source);
  if ((await realpath(source)) !== source) throw Error("Gateway composition directory must be canonical");
  const vfs = await openPackageVfs({
    sha256,
    async readFile(path, limit) {
      const file = join(source, path);
      for (let parent = dirname(file); parent !== source; parent = dirname(parent)) await checkedDirectory(parent);
      return boundedFile(file, limit);
    },
  });
  const names = vfs.listFiles();
  if (!names.includes(entry)) throw Error("Gateway composition package requires " + entry);
  // Only verified package bytes are imported. Sidecars stay available for the
  // existing Headless extensions and their Workers throughout the server lifetime.
  const directory = await mkdtemp(join(await realpath(tmpdir()), "opencraft-composition-"));
  const release = () => rm(directory, { recursive: true, force: true });
  try {
    for (const name of names) {
      const target = join(directory, name);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, vfs.readFile(name), { mode: 0o400, flag: "wx" });
    }
    const module = await import(pathToFileURL(join(directory, entry)).href);
    if (module.gatewayCompositionApi !== 1 || typeof module.createGatewayComposition !== "function")
      throw Error("Incompatible Gateway composition API (expected version 1)");
    const composition = await module.createGatewayComposition();
    if (!plain(composition)) throw Error("Gateway composition must be a plain object");
    for (const [name, value] of Object.entries(composition)) {
      const valid = functions.has(name)
        ? typeof value === "function"
        : name === "channelSyncs"
          ? Array.isArray(value)
          : objects.has(name) && plain(value);
      if (!valid) throw Error("Invalid Gateway composition property: " + name);
    }
    if (
      ["channelSync", "channelSyncs", "createChannelSync", "createChannelSyncs"].filter((name) =>
        Object.hasOwn(composition, name),
      ).length > 1
    )
      throw Error("Conflicting Gateway channel composition");
    for (const { kind, url } of validateHeadlessExtensions(composition.extensions)) {
      const path = new URL(url);
      if (path.search || path.hash || !names.includes(relative(directory, fileURLToPath(path)).split(sep).join("/")))
        throw Error("Gateway " + kind + " extension must be listed in the composition manifest");
    }
    validateCodexWorkspaceHooks(composition);
    validateLoginAdmission(composition.loginAdmission);
    validateRuntimePluginOptions(composition.runtimePlugins);
    prepareProductServerMigrations(composition.serverMigrations);
    let closing;
    return {
      sha256,
      composition: {
        ...composition,
        close() {
          return (closing ??= Promise.resolve()
            .then(() => composition.close?.())
            .finally(release));
        },
      },
    };
  } catch (error) {
    await release().catch(() => {});
    throw error;
  }
}

/** This command runs in a separate process before the live service is switched. */
export async function checkGatewayComposition(composition) {
  await loadHeadlessExtensions(validateHeadlessExtensions(composition.extensions));
  const migrations = prepareProductServerMigrations(composition.serverMigrations);
  if (migrations) verifyExtensionFamilies(migrations);
}
