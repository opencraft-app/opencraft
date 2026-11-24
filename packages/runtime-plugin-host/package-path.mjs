export function safePath(value) {
  if (
    typeof value !== "string" ||
    value.length > 256 ||
    !/^[A-Za-z0-9_./-]+$/u.test(value) ||
    value.split("/").some((part) => !part || part === "." || part === ".." || part.startsWith("."))
  )
    throw Error("Invalid plugin path");
  return value;
}
