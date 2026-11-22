export interface BrowserRuntimeManifest {
  version: 1;
  /** Ordered archives: a pinned companion may overlay its base runtime. */
  archives: readonly { path: string; sha256: string }[];
}
export function browserRuntimeManifest(input: BrowserRuntimeManifest): BrowserRuntimeManifest {
  if (input?.version !== 1 || !Array.isArray(input.archives) || input.archives.length < 1 || input.archives.length > 4)
    throw Error("Invalid browser runtime manifest");
  return Object.freeze({
    version: 1,
    archives: Object.freeze(
      input.archives.map((entry) => {
        if (
          !entry ||
          typeof entry.path !== "string" ||
          !/^\/(?:shared\/\.opencraft|opt\/opencraft)\/runtime-cache\/[a-zA-Z0-9._-]{1,160}\.(?:tgz|tar\.gz)$/.test(
            entry.path,
          ) ||
          typeof entry.sha256 !== "string" ||
          !/^[a-f0-9]{64}$/.test(entry.sha256)
        )
          throw Error("Invalid browser runtime archive");
        return Object.freeze({ path: entry.path, sha256: entry.sha256 });
      }),
    ),
  });
}
