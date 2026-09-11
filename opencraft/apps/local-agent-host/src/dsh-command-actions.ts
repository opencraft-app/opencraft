import { basename, resolve } from "node:path";

/** Display classification only; never used to authorize execution. */
export function classifyDshCommand(command: string, cwd: string) {
  const unknown = [{ type: "unknown", command }];
  // Compound commands and expansions require a shell parser. Preserve them as
  // unknown instead of claiming a pipeline or substitution is a read-only action.
  if (/[\n\r;&|<>`$\\*?{}()[\]~#]/u.test(command)) return unknown;
  const tokens = command.match(/"[^"\n]*"|'[^'\n]*'|[^\s"']+/gu) ?? [];
  if (tokens.join("").replace(/["']/gu, "") !== command.replace(/\s|["']/gu, "")) return unknown;
  if ((command.match(/"/gu)?.length ?? 0) % 2 || (command.match(/'/gu)?.length ?? 0) % 2) return unknown;
  const words = tokens.map(token => /^["']/u.test(token) ? token.slice(1, -1) : token);
  const [name, ...args] = words;
  if (!name || args.some(arg => arg.startsWith("-"))) return unknown;
  if (["cat", "head", "tail"].includes(name) && args.length === 1) {
    const path = resolve(cwd, args[0]);
    return [{ type: "read", command, name: basename(path), path }];
  }
  if (name === "ls" && args.length <= 1) return [{ type: "listFiles", command, path: args[0] ? resolve(cwd, args[0]) : cwd }];
  if (["rg", "grep"].includes(name) && args.length >= 1 && args.length <= 2) return [{ type: "search", command, query: args[0], path: args[1] ? resolve(cwd, args[1]) : cwd }];
  return unknown;
}
