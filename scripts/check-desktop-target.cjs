// Bundled DSH contains native modules. Copying a host install into a different
// OS/architecture can produce a valid archive that cannot actually launch.
module.exports = async function beforePack(context) {
  const architectures = { 0: "ia32", 1: "x64", 2: "armv7l", 3: "arm64", 4: "universal" };
  const target = architectures[context.arch];
  if (context.electronPlatformName !== process.platform || target !== process.arch) {
    throw new Error(`Bundled DSH requires a native ${context.electronPlatformName}/${target} build. Current builder is ${process.platform}/${process.arch}. Run npm ci and the package command on the target OS/architecture.`);
  }
};
