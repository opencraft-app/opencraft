/** Display paths only; resource actions always retain the original path. */
export function presentSummaryFiles(paths: readonly string[]) {
  const parts = paths.map(path => path.replace(/\\/gu, "/").split("/"));
  const common = parts[0]?.slice(0, -1) ?? [];
  for (const path of parts.slice(1)) {
    let length = 0;
    while (length < common.length && length < path.length - 1 && common[length] === path[length]) length++;
    common.length = length;
  }
  const root = common.join("/");
  return {
    root,
    rootLabel: common.filter(Boolean).at(-1) ?? root,
    files: parts.map(path => {
      const name = path.at(-1) ?? "";
      const dot = name.lastIndexOf(".");
      return {
        name,
        stem: dot > 0 ? name.slice(0, dot) : name,
        extension: dot > 0 ? name.slice(dot) : "",
        directory: path.slice(common.length, -1).join("/"),
      };
    }),
  };
}
