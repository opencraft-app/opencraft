import path from "node:path";

export function isBareModuleSpecifier(specifier) {
  return !!specifier && !specifier.startsWith(".") && !specifier.startsWith("/")
    && !specifier.startsWith("#") && !specifier.startsWith("\0")
    && !/^[a-z][a-z\d+.-]*:/iu.test(specifier);
}

export function isExternalWorkspaceSource(root, importer) {
  const file = importer.split("?")[0];
  if (!path.isAbsolute(file)) return false;
  const relative = path.relative(root, file);
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}
