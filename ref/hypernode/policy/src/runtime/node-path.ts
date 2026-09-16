function parts(path: string): string[] {
  return path.split("/");
}

export function isAbsolute(path: unknown): path is string {
  return typeof path === "string" && path.startsWith("/");
}

export function normalize(path: string): string {
  const absolute = path.startsWith("/");
  const output: string[] = [];
  for (const part of parts(path)) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (output.length > 0 && output.at(-1) !== "..") output.pop();
      else if (!absolute) output.push(part);
      continue;
    }
    output.push(part);
  }
  const joined = output.join("/");
  if (absolute) return `/${joined}` || "/";
  return joined || ".";
}

export function join(...paths: string[]): string {
  return normalize(paths.filter((path) => path !== "").join("/"));
}

export function resolve(...paths: string[]): string {
  let resolved = "";
  for (let index = paths.length - 1; index >= 0; index -= 1) {
    const path = paths[index];
    if (!path) continue;
    resolved = resolved ? `${path}/${resolved}` : path;
    if (path.startsWith("/")) return normalize(resolved);
  }
  return normalize(`/${resolved}`);
}

export function dirname(path: string): string {
  const value = normalize(path);
  if (value === "/" || value === ".") return value;
  const index = value.lastIndexOf("/");
  if (index < 0) return ".";
  return index === 0 ? "/" : value.slice(0, index);
}

export function basename(path: string, suffix = ""): string {
  const value = normalize(path);
  const name = value === "/" ? "" : value.slice(value.lastIndexOf("/") + 1);
  return suffix && name.endsWith(suffix) ? name.slice(0, -suffix.length) : name;
}

export const sep = "/";
export const delimiter = ":";
export const posix = { isAbsolute, normalize, join, resolve, dirname, basename, sep, delimiter };
export default posix;
