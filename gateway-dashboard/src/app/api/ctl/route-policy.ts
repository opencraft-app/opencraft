export function requiresCtlOperatorToken(path: string[], method: string): boolean {
  if (method.toUpperCase() !== "POST") return false;
  return (
    path.length === 4 && path[0] === "instances" && path[2] === "gateway" && path[3] === "migrate"
  ) || (
    path.length === 5 && path[0] === "users" && path[2] === "gateway" && path[3] === "quota" && path[4] === "reset"
  );
}
