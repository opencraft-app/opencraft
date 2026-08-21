const DSH_RELEASE = "0.1.0-rc.7";

function pinDshRelease(dependencies) {
  if (!dependencies) return;
  for (const name of Object.keys(dependencies)) {
    if (name === "@deepseek-ai/dsh" || name.startsWith("@deepseek-ai/dsh-")) {
      dependencies[name] = DSH_RELEASE;
    }
  }
}

module.exports = {
  hooks: {
    readPackage(pkg) {
      pinDshRelease(pkg.dependencies);
      pinDshRelease(pkg.optionalDependencies);
      pinDshRelease(pkg.peerDependencies);
      return pkg;
    },
  },
};
