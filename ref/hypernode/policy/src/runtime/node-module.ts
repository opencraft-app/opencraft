// Minimal `node:module` compatibility for packages evaluated inside QuickJS.
// DSH LLM only reads its own package version for the attribution header.
// Keep this aligned with dsh-upstream.lock.json and the exact npm dependency.
const DSH_LLM_VERSION = "0.1.1-rc.2";

interface PackageVersion {
  version: string;
}

export function createRequire(): (specifier: string) => PackageVersion {
  return (specifier) => {
    if (specifier === "../package.json") {
      return { version: DSH_LLM_VERSION };
    }
    throw new Error(`QuickJS createRequire does not support ${specifier}`);
  };
}

export default { createRequire };
