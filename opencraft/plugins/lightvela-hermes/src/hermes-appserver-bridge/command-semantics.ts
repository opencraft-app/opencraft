/** Display semantics only. Never use this parser to authorize execution.
 * Unknown shell syntax remains a command, including expansions and redirects. */
export function classifyCommand(command: string): Record<string, unknown>[] {
  const unknown = () => [{ type: "unknown", command }];
  if (/[\n\r;&|<>`$*?{}()\\[\]~#]/u.test(command)) return unknown();
  const words: string[] = [];
  const token = /\s*(?:"([^"\n]*)"|'([^'\n]*)'|([^\s'"]+))/gy;
  let offset = 0;
  while (offset < command.trimEnd().length) {
    token.lastIndex = offset;
    const match = token.exec(command);
    if (!match) return unknown();
    words.push(match[1] ?? match[2] ?? match[3]);
    offset = token.lastIndex;
  }
  const [executable, ...args] = words;
  // Only bare known commands: aliases, wrappers, interpreter code and arbitrary
  // paths are not evidence for a semantic read. Preserve the original command.
  if (executable === "ls") {
    const paths: string[] = [];
    let operands = false;
    for (const arg of args) {
      if (arg === "--" && !operands) { operands = true; continue; }
      if (!operands && arg.startsWith("-")) { if (!/^-[alhAFRdt1]+$/u.test(arg)) return unknown(); }
      else paths.push(arg);
    }
    return paths.length <= 1 ? [{ type: "listFiles", command, path: paths[0] ?? null }] : unknown();
  }
  if (executable === "cat") {
    const paths = args[0] === "--" ? args.slice(1) : args;
    if (paths.length === 1 && paths[0] && !paths[0].startsWith("-")) {
      return [{ type: "read", command, path: paths[0], name: paths[0].split("/").at(-1) }];
    }
  }
  if (executable === "rg" || executable === "grep") {
    let index = 0;
    while (args[index]?.startsWith("-") && args[index] !== "--") {
      if (!/^-[niwF]+$/u.test(args[index])) return unknown();
      index++;
    }
    if (args[index] === "--") index++;
    const operands = args.slice(index);
    if (operands.length >= 1 && operands.length <= 2) return [{ type: "search", command, query: operands[0], path: operands[1] ?? null }];
  }
  return unknown();
}
