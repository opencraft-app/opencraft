const { access, chmod, readdir, rm, stat } = require("node:fs/promises");
const { constants } = require("node:fs");
const { join, resolve } = require("node:path");
const { Arch } = require("builder-util");

// Runs on the assembled package before signing. npm's prebuilt spawn-helper
// can arrive with mode 0644; copying it faithfully produces an unusable PTY.
async function pruneForeignPrebuilds(root, target) {
  const prebuilds = join(root, "prebuilds");
  let entries;
  try { entries = await readdir(prebuilds, { withFileTypes: true }); } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  await Promise.all(entries
    .filter((entry) => entry.isDirectory() && entry.name !== target)
    .map((entry) => rm(join(prebuilds, entry.name), { recursive: true, force: true })));
}

async function preparePackagedPty(context) {
  if (context.electronPlatformName === "win32") return;
  const resources = context.electronPlatformName === "darwin"
    ? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, "Contents", "Resources")
    : join(context.appOutDir, "resources");
  const root = join(resources, "runtime", "node_modules", "node-pty");
  const target = `${context.electronPlatformName}-${Arch[context.arch]}`;
  await Promise.all([
    pruneForeignPrebuilds(root, target),
    pruneForeignPrebuilds(join(resources, "runtime", "dsh", "node_modules", "node-pty"), target),
  ]);
  const candidates = ["build/Release", "build/Debug", `prebuilds/${context.electronPlatformName}-${Arch[context.arch]}`];
  let prepared = false;
  for (const directory of candidates) {
    const native = join(root, directory, "pty.node");
    try { await stat(native); } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    const helper = join(root, directory, "spawn-helper");
    if (!(await stat(helper)).isFile()) throw new Error(`Invalid PTY helper: ${helper}`);
    await chmod(helper, 0o755);
    await access(helper, constants.X_OK);
    prepared = true;
    break;
  }
  if (!prepared) throw new Error(`Packaged PTY native module is missing for ${context.electronPlatformName}-${Arch[context.arch]}`);
  if (context.electronPlatformName === "darwin" && process.env.OPENCRAFT_MAC_PREVIEW === "1") {
    const { signMacosPreview } = await import("./sign-macos-preview.mjs");
    const appPath = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
    const configuredEntitlements = context.packager.config?.mac?.entitlements;
    const entitlementsPath = configuredEntitlements
      ? resolve(context.packager.projectDir, configuredEntitlements)
      : join(__dirname, "../node_modules/app-builder-lib/templates/entitlements.mac.plist");
    await signMacosPreview({ appPath, entitlementsPath });
  }
}

module.exports = preparePackagedPty;
module.exports.pruneForeignPrebuilds = pruneForeignPrebuilds;
