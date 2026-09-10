const { access, chmod, stat } = require("node:fs/promises");
const { constants } = require("node:fs");
const { join } = require("node:path");
const { Arch } = require("builder-util");

// Runs on the assembled package before signing. npm's prebuilt spawn-helper
// can arrive with mode 0644; copying it faithfully produces an unusable PTY.
module.exports = async function preparePackagedPty(context) {
  if (context.electronPlatformName === "win32") return;
  const resources = context.electronPlatformName === "darwin"
    ? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, "Contents", "Resources")
    : join(context.appOutDir, "resources");
  const root = join(resources, "runtime", "node_modules", "node-pty");
  const candidates = ["build/Release", "build/Debug", `prebuilds/${context.electronPlatformName}-${Arch[context.arch]}`];
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
    return;
  }
  throw new Error(`Packaged PTY native module is missing for ${context.electronPlatformName}-${Arch[context.arch]}`);
};
