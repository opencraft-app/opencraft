// Bundled DSH contains native modules. Copying a host install into a different
// OS/architecture can produce a valid archive that cannot actually launch.
module.exports = async function beforePack(context) {
  const { readFileSync } = require("node:fs");
  const { join } = require("node:path");
  const { createHash } = require("node:crypto");
  const appDir = context.packager.info.appDir;
  const identities = JSON.parse(readFileSync(join(appDir, "dist-host/desktop-identity.json"), "utf8"));
  const mainSha256 = createHash("sha256").update(readFileSync(join(appDir, "dist-host/main.cjs"))).digest("hex");
  if (mainSha256 !== identities.mainSha256) throw new Error("Desktop package Main bundle differs from its identity record");
  const productName = context.packager.appInfo.productName;
  const selected = productName === identities.preview.displayName ? identities.preview : identities.production;
  if (productName !== selected.displayName || context.packager.appInfo.id !== selected.applicationId) {
    throw new Error(`Desktop package identity mismatch: ${productName} (${context.packager.appInfo.id}) does not match the bundled ${selected.displayName} (${selected.applicationId})`);
  }
  const architectures = { 0: "ia32", 1: "x64", 2: "armv7l", 3: "arm64", 4: "universal" };
  const target = architectures[context.arch];
  if (context.electronPlatformName !== process.platform || target !== process.arch) {
    throw new Error(`Bundled DSH requires a native ${context.electronPlatformName}/${target} build. Current builder is ${process.platform}/${process.arch}. Run npm ci and the package command on the target OS/architecture.`);
  }
};
