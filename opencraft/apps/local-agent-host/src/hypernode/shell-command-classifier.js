// Source: ref/hypernode/policy/src/services/shell-command-classifier.js
// Only the Cordis registration base is replaced; classification remains pure.
class Service { constructor(ctx) { this.ctx = ctx; } }

// Semantic port of codex-shell-command 0.148.0-alpha.21 parse_command.rs.
// Keep behavior changes test-driven against the vendored upstream corpus.

const CONNECTORS = new Set(["&&", "||", "|", ";"]);
const POWERSHELL_FLAGS = new Set(["-nologo", "-noprofile", "-command", "-c"]);

function quoteShellWord(value) {
  const word = String(value);
  if (!word) return "''";
  if (/^[+\-./:@\]_0-9A-Za-z]+$/.test(word)) return word;
  if (word.includes("\\") && !/[\n\r]/.test(word)) {
    return `"${word.replace(/[\\"$`]/g, "\\$&")}"`;
  }
  if (!word.includes("'")) return `'${word}'`;
  if (!/[\\"$`]/.test(word)) return `"${word}"`;
  return word.split("'").map((chunk) => `'${chunk}'`).join('"\'"');
}

export function shlexJoin(tokens) {
  if (tokens.some((token) => String(token).includes("\0"))) {
    return "<command included NUL byte>";
  }
  return tokens.map(quoteShellWord).join(" ");
}

function lexShell(source, { validateScript = false } = {}) {
  const tokens = [];
  let token = "";
  let tokenStarted = false;
  let quote = null;
  let escaped = false;
  let safe = true;
  const flush = () => {
    if (tokenStarted) tokens.push(token);
    token = "";
    tokenStarted = false;
  };

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    const next = source[i + 1];
    if (escaped) {
      token += char;
      tokenStarted = true;
      escaped = false;
      continue;
    }
    if (quote === "'") {
      if (char === "'") quote = null;
      else token += char;
      tokenStarted = true;
      continue;
    }
    if (quote === '"') {
      if (char === '"') {
        quote = null;
      } else if (char === "\\") {
        escaped = true;
      } else {
        // A quoted command substitution is validated structurally after
        // tokenization. Unquoted substitutions still trip the unsafe `(`
        // branch below, and backticks are never accepted.
        if (validateScript && char === "`") safe = false;
        token += char;
      }
      tokenStarted = true;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      tokenStarted = true;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      tokenStarted = true;
      continue;
    }
    const stderrDiscard = "2>/dev/null";
    const redirectEnd = i + stderrDiscard.length;
    if (
      validateScript
      && source.startsWith(stderrDiscard, i)
      && (i === 0 || /[\s;&|]/.test(source[i - 1]))
      && (redirectEnd === source.length || /[\s;&|]/.test(source[redirectEnd]))
    ) {
      flush();
      i = redirectEnd - 1;
      continue;
    }
    if (char === "\n" || char === "\r") {
      flush();
      let lookahead = i + 1;
      if (char === "\r" && source[lookahead] === "\n") lookahead += 1;
      while (lookahead < source.length && /[ \t\r\n]/.test(source[lookahead])) lookahead += 1;
      const previous = tokens.at(-1);
      const nextNonWhitespace = source[lookahead];
      // An unquoted newline is a shell command separator, except when it
      // continues an explicit connector (`cmd |\n formatter`, for example).
      if (
        tokens.length
        && !CONNECTORS.has(previous)
        && previous !== ";"
        && nextNonWhitespace != null
        && nextNonWhitespace !== "|"
        && nextNonWhitespace !== ";"
      ) tokens.push(";");
      if (char === "\r" && source[i + 1] === "\n") i += 1;
      continue;
    }
    if (/\s/.test(char)) {
      flush();
      continue;
    }
    if (char === "&" && next === "&") {
      flush(); tokens.push("&&"); i += 1; continue;
    }
    if (char === "|" && next === "|") {
      flush(); tokens.push("||"); i += 1; continue;
    }
    if (char === "|" || char === ";") {
      flush(); tokens.push(char); continue;
    }
    if (validateScript && (char === ">" || char === "<" || char === "`" || char === "(" || char === ")" || char === "{" || char === "}" || char === "#")) {
      safe = false;
    }
    token += char;
    tokenStarted = true;
  }
  if (escaped || quote) safe = false;
  flush();
  return { tokens, safe };
}

export function tokenizeShellWords(source) {
  return lexShell(String(source)).tokens;
}

function shellBasename(value) {
  return String(value).replace(/\\/g, "/").split("/").at(-1).toLowerCase();
}

function extractBashCommand(command) {
  if (command.length !== 3 || !new Set(["-c", "-lc"]).has(command[1])) return null;
  const shell = shellBasename(command[0]);
  return new Set(["bash", "zsh", "sh"]).has(shell) ? command[2] : null;
}

function extractPowershellCommand(command) {
  if (command.length < 3) return null;
  const shell = shellBasename(command[0]);
  if (!new Set(["powershell", "powershell.exe", "pwsh", "pwsh.exe"]).has(shell)) return null;
  for (let i = 1; i + 1 < command.length; i += 1) {
    const flag = String(command[i]).toLowerCase();
    if (!POWERSHELL_FLAGS.has(flag)) return null;
    if (flag === "-command" || flag === "-c") return command[i + 1];
  }
  return null;
}

function tokenizePowershellCommand(command) {
  const normalized = String(command).replace(/\\/g, "/");
  const tokens = tokenizeShellWords(normalized);
  if (tokens.length && new Set(["get-content", "gc", "type"]).has(tokens[0].toLowerCase())) {
    tokens[0] = "Get-Content";
    if (tokens.slice(1).some((argument) => !normalized.includes(argument))) return [];
  }
  return tokens;
}

function unknown(cmd) { return { type: "unknown", cmd }; }
function listFiles(cmd, path = null) { return { type: "list_files", cmd, path }; }
function search(cmd, query = null, path = null) { return { type: "search", cmd, query, path }; }
function read(cmd, path) { return { type: "read", cmd, name: shortDisplayPath(path), path }; }

function parsedEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function singleUnknownForCommand(command) {
  const script = extractBashCommand(command) ?? extractPowershellCommand(command);
  return unknown(script ?? shlexJoin(command));
}

export function parseCommand(command) {
  const argv = Array.isArray(command) ? command.map(String) : tokenizeShellWords(String(command));
  const parsed = parseCommandImpl(argv);
  const deduped = [];
  for (const entry of parsed) {
    if (!deduped.length || !parsedEqual(deduped.at(-1), entry)) deduped.push(entry);
  }
  return deduped.some((entry) => entry.type === "unknown")
    ? [singleUnknownForCommand(argv)]
    : deduped;
}

function parseCommandImpl(command) {
  const bashScript = extractBashCommand(command);
  if (bashScript != null) return parseShellScript(bashScript);

  const powershellScript = extractPowershellCommand(command);
  if (powershellScript != null) {
    const tokens = tokenizePowershellCommand(powershellScript);
    const parsed = parseCommandImpl(tokens);
    if (tokens[0] === "Get-Content" && parsed.length === 1 && parsed[0].type === "read") {
      return [{ ...parsed[0], cmd: powershellScript }];
    }
    return [unknown(powershellScript)];
  }

  const normalized = normalizeTokens(command);
  const parts = containsConnectors(normalized) ? splitOnConnectors(normalized) : [normalized];
  const commands = [];
  let cwd = null;
  for (const tokens of parts) {
    if (tokens[0] === "cd") {
      const dir = cdTarget(tokens.slice(1));
      if (dir != null) cwd = cwd == null ? dir : joinPaths(cwd, dir);
      continue;
    }
    let parsed = summarizeMainTokens(tokens);
    if (parsed.type === "read" && cwd != null) parsed = { ...parsed, path: joinPaths(cwd, parsed.path) };
    commands.push(parsed);
  }
  return simplifyCommands(commands);
}

function simplifyCommands(input) {
  let commands = input;
  for (;;) {
    const next = simplifyOnce(commands);
    if (!next) return commands;
    commands = next;
  }
}

function simplifyOnce(commands) {
  if (commands.length <= 1) return null;
  // Treat a side-effect-free echo inside a compound command as presentation-only.
  // The upstream parser already drops a leading echo; doing this positionally keeps
  // later semantic Search/Read actions visible as well. Unsafe shell constructs
  // (including redirection and command substitution) never reach this simplifier.
  const echoIndex = commands.findIndex((entry) => (
    entry.type === "unknown" && tokenizeShellWords(entry.cmd)[0] === "echo"
  ));
  if (echoIndex >= 0) return commands.filter((_, index) => index !== echoIndex);
  const cdIndex = commands.findIndex((entry) => entry.type === "unknown" && tokenizeShellWords(entry.cmd)[0] === "cd");
  if (cdIndex >= 0 && commands.length > cdIndex + 1) return commands.filter((_, index) => index !== cdIndex);
  const trueIndex = commands.findIndex((entry) => entry.type === "unknown" && entry.cmd === "true");
  if (trueIndex >= 0) return commands.filter((_, index) => index !== trueIndex);
  const nlIndex = commands.findIndex((entry) => {
    if (entry.type !== "unknown") return false;
    const tokens = tokenizeShellWords(entry.cmd);
    return tokens[0] === "nl" && tokens.slice(1).every((token) => token.startsWith("-"));
  });
  if (nlIndex >= 0) return commands.filter((_, index) => index !== nlIndex);
  return null;
}

function isValidSedNArg(arg) {
  if (typeof arg !== "string" || !arg.endsWith("p")) return false;
  const parts = arg.slice(0, -1).split(",");
  return (parts.length === 1 || parts.length === 2) && parts.every((part) => /^\d+$/.test(part));
}

function commandSubstitutionParts(value) {
  if (typeof value !== "string" || !value.startsWith("$(")) return null;
  let depth = 1;
  let quote = null;
  let escaped = false;
  for (let index = 2; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === "(") depth += 1;
    else if (character === ")") {
      depth -= 1;
      if (depth === 0) {
        return {
          command: value.slice(2, index),
          suffix: value.slice(index + 1),
        };
      }
    }
  }
  return null;
}

function isSafeLineLocator(command) {
  const lexed = lexShell(command, { validateScript: true });
  if (!lexed.safe || !lexed.tokens.length || lexed.tokens.some((token) => token.includes("$("))) {
    return false;
  }
  const segments = splitOnConnectorsWithContext(lexed.tokens);
  if (!segments.length || segments.slice(1).some(({ connectorBefore }) => connectorBefore !== "|")) {
    return false;
  }
  if (summarizeMainTokens(segments[0].tokens).type !== "search") return false;
  return segments.slice(1).every(({ tokens }) => (
    new Set(["head", "tail", "cut"]).has(tokens[0]) && isSmallFormattingCommand(tokens)
  ));
}

function isSafeDynamicSedNArg(arg) {
  const parts = commandSubstitutionParts(arg);
  if (!parts || !/^(?:,[+-]?\d+)?p$/.test(parts.suffix)) return false;
  return isSafeLineLocator(parts.command);
}

function hasOnlySafeCommandSubstitutions(tokens) {
  for (const { tokens: segment } of splitOnConnectorsWithContext(tokens)) {
    const substitutions = segment.filter((token) => token.includes("$("));
    if (!substitutions.length) continue;
    if (
      segment[0] !== "sed"
      || !segment.includes("-n")
      || substitutions.length !== 1
      || !isSafeDynamicSedNArg(substitutions[0])
    ) return false;
  }
  return true;
}

function sedReadPath(args) {
  const values = trimAtConnector(args);
  if (!values.includes("-n")) return null;
  let hasRange = false;
  for (let i = 0; i < values.length; i += 1) {
    if (new Set(["-e", "--expression"]).has(values[i])) {
      if (isValidSedNArg(values[i + 1])) hasRange = true;
      i += 1;
    } else if (new Set(["-f", "--file"]).has(values[i])) {
      i += 1;
    }
  }
  if (!hasRange) {
    hasRange = values.some((arg) => (
      !arg.startsWith("-") && (isValidSedNArg(arg) || isSafeDynamicSedNArg(arg))
    ));
  }
  if (!hasRange) return null;
  const nonFlags = skipFlagValues(values, ["-e", "-f", "--expression", "--file"])
    .filter((arg) => !arg.startsWith("-"));
  if (!nonFlags.length) return null;
  return (isValidSedNArg(nonFlags[0]) || isSafeDynamicSedNArg(nonFlags[0]))
    ? (nonFlags[1] ?? null)
    : nonFlags[0];
}

function normalizeTokens(command) {
  if (command.length >= 3 && new Set(["yes", "y", "no", "n"]).has(command[0]) && command[1] === "|") return command.slice(2);
  if (command.length === 3 && new Set(["bash", "zsh"]).has(command[0]) && new Set(["-c", "-lc"]).has(command[1])) {
    return tokenizeShellWords(command[2]);
  }
  return [...command];
}

function containsConnectors(tokens) { return tokens.some((token) => CONNECTORS.has(token)); }
function splitOnConnectors(tokens) {
  const output = [];
  let current = [];
  for (const token of tokens) {
    if (CONNECTORS.has(token)) {
      if (current.length) output.push(current);
      current = [];
    } else current.push(token);
  }
  if (current.length) output.push(current);
  return output;
}

function splitOnConnectorsWithContext(tokens) {
  const output = [];
  let current = [];
  let connectorBefore = null;
  for (const token of tokens) {
    if (CONNECTORS.has(token)) {
      if (current.length) output.push({ tokens: current, connectorBefore });
      current = [];
      connectorBefore = token;
    } else current.push(token);
  }
  if (current.length) output.push({ tokens: current, connectorBefore });
  return output;
}
function trimAtConnector(tokens) {
  const index = tokens.findIndex((token) => CONNECTORS.has(token));
  return tokens.slice(0, index < 0 ? tokens.length : index);
}

function shortDisplayPath(path) {
  const normalized = String(path).replace(/\\/g, "/").replace(/\/+$/, "");
  const ignored = new Set(["build", "dist", "node_modules", "src"]);
  return normalized.split("/").reverse().find((part) => part && !ignored.has(part)) ?? normalized;
}

function skipFlagValues(args, flagsWithValues) {
  const flags = new Set(flagsWithValues);
  const output = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--") return output.concat(args.slice(i + 1));
    if (arg.startsWith("--") && arg.includes("=")) continue;
    if (flags.has(arg)) { i += 1; continue; }
    output.push(arg);
  }
  return output;
}

function positionalOperands(args, flagsWithValues) {
  const flags = new Set(flagsWithValues);
  const output = [];
  let afterDoubleDash = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (afterDoubleDash) { output.push(arg); continue; }
    if (arg === "--") { afterDoubleDash = true; continue; }
    if (arg.startsWith("--") && arg.includes("=")) continue;
    if (flags.has(arg)) { i += 1; continue; }
    if (!arg.startsWith("-")) output.push(arg);
  }
  return output;
}
function firstNonFlagOperand(args, flags) { return positionalOperands(args, flags)[0] ?? null; }
function singleNonFlagOperand(args, flags) {
  const operands = positionalOperands(args, flags);
  return operands.length === 1 ? operands[0] : null;
}

function parseGrepLike(mainCommand, args) {
  const values = trimAtConnector(args);
  const operands = [];
  let pattern = null;
  let afterDoubleDash = false;
  for (let i = 0; i < values.length; i += 1) {
    const arg = values[i];
    if (afterDoubleDash) { operands.push(arg); continue; }
    if (arg === "--") { afterDoubleDash = true; continue; }
    if (new Set(["-e", "--regexp", "-f", "--file"]).has(arg)) {
      if (pattern == null) pattern = values[i + 1] ?? null;
      i += 1; continue;
    }
    if (new Set(["-m", "--max-count", "-C", "--context", "-A", "--after-context", "-B", "--before-context"]).has(arg)) {
      i += 1; continue;
    }
    if (arg.startsWith("-")) continue;
    operands.push(arg);
  }
  const hadPattern = pattern != null;
  const query = pattern ?? operands[0] ?? null;
  const path = operands[hadPattern ? 0 : 1];
  return search(shlexJoin(mainCommand), query, path == null ? null : shortDisplayPath(path));
}

function awkDataFileOperand(args) {
  if (!args.length) return null;
  const values = trimAtConnector(args);
  const hasScriptFile = values.some((arg) => new Set(["-f", "--file"]).has(arg));
  const nonFlags = skipFlagValues(values, ["-F", "-v", "-f", "--field-separator", "--assign", "--file"])
    .filter((arg) => !arg.startsWith("-"));
  return hasScriptFile ? (nonFlags[0] ?? null) : (nonFlags[1] ?? null);
}

function pythonWalksFiles(args) {
  const values = trimAtConnector(args);
  for (let i = 0; i < values.length; i += 1) {
    if (values[i] !== "-c") continue;
    const script = values[i + 1] ?? "";
    return ["os.walk", "os.listdir", "os.scandir", "glob.glob", "glob.iglob", "pathlib.Path", ".rglob("]
      .some((needle) => script.includes(needle));
  }
  return false;
}

function isPythonCommand(command) {
  return /^(?:python|python2|python3|python2\.|python3\.)/.test(command)
    && (/^python(?:2|3)?$/.test(command) || /^python[23]\./.test(command));
}

function cdTarget(args) {
  let target = null;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--") return args[i + 1] ?? null;
    if (new Set(["-L", "-P"]).has(args[i]) || args[i].startsWith("-")) continue;
    target = args[i];
  }
  return target;
}

function isPathish(value) {
  return value === "." || value === ".." || value.startsWith("./") || value.startsWith("../") || value.includes("/") || value.includes("\\");
}

function parseFdQueryAndPath(tail) {
  const candidates = skipFlagValues(trimAtConnector(tail), ["-t", "--type", "-e", "--extension", "-E", "--exclude", "--search-path"])
    .filter((entry) => !entry.startsWith("-"));
  if (candidates.length === 1) return isPathish(candidates[0]) ? [null, shortDisplayPath(candidates[0])] : [candidates[0], null];
  if (candidates.length >= 2) return [candidates[0], shortDisplayPath(candidates[1])];
  return [null, null];
}

function parseFindQueryAndPath(tail) {
  const values = trimAtConnector(tail);
  const root = values.find((entry) => !entry.startsWith("-") && !new Set(["!", "(", ")"]).has(entry));
  let query = null;
  for (let i = 0; i < values.length; i += 1) {
    if (new Set(["-name", "-iname", "-path", "-regex"]).has(values[i])) {
      query = values[i + 1] ?? null; break;
    }
  }
  return [query, root == null ? null : shortDisplayPath(root)];
}

function parseShellScript(script) {
  const lexed = lexShell(script, { validateScript: true });
  if (
    !lexed.safe
    || !lexed.tokens.length
    || !hasOnlySafeCommandSubstitutions(lexed.tokens)
  ) return [unknown(script)];
  let segments = splitOnConnectorsWithContext(lexed.tokens);
  if (!segments.length) return [unknown(script)];
  const hadMultipleCommands = segments.length > 1;
  segments = segments.filter(({ tokens, connectorBefore }) => (
    !isSmallFormattingCommand(tokens)
    && !isInverseSearchStreamFilter(tokens, connectorBefore)
  ));
  const allCommands = segments.map(({ tokens }) => tokens);
  if (!allCommands.length) return [unknown(script)];
  const commands = [];
  let cwd = null;
  for (const tokens of allCommands) {
    if (tokens[0] === "cd") {
      const dir = cdTarget(tokens.slice(1));
      if (dir != null) cwd = cwd == null ? dir : joinPaths(cwd, dir);
      continue;
    }
    let parsed = summarizeMainTokens(tokens);
    if (parsed.type === "read" && cwd != null) parsed = { ...parsed, path: joinPaths(cwd, parsed.path) };
    commands.push(parsed);
  }
  let simplified = commands;
  if (simplified.length > 1) {
    simplified = simplified.filter((entry) => !(entry.type === "unknown" && entry.cmd === "true"));
    simplified = simplifyCommands(simplified);
  }
  if (simplified.length === 1) {
    const parsed = simplified[0];
    const hadConnectors = hadMultipleCommands || lexed.tokens.some((token) => CONNECTORS.has(token));
    if (parsed.type === "read") {
      if (hadConnectors) {
        const hasPipe = lexed.tokens.includes("|");
        const hasSedN = lexed.tokens.some((token, index) => token === "sed" && lexed.tokens[index + 1] === "-n");
        if (hasPipe && hasSedN) parsed.cmd = script;
      } else parsed.cmd = shlexJoin(lexed.tokens);
    } else if (new Set(["list_files", "search"]).has(parsed.type) && !hadConnectors) {
      parsed.cmd = shlexJoin(lexed.tokens);
    }
  }
  return simplified;
}

function isInverseSearchStreamFilter(tokens, connectorBefore) {
  if (connectorBefore !== "|" || !tokens.length) return false;
  const [command, ...args] = tokens;
  if (!new Set(["grep", "egrep", "fgrep", "rg", "rga", "ag", "ack", "pt"]).has(command)) {
    return false;
  }
  return args.some((argument) => argument === "-v" || argument === "--invert-match");
}

function isMutatingXargsCommand(tokens) {
  const subcommand = xargsSubcommand(tokens);
  if (!subcommand?.length) return false;
  const [head, ...tail] = subcommand;
  if (new Set(["perl", "ruby"]).has(head)) return xargsHasInPlaceFlag(tail);
  if (head === "sed") return xargsHasInPlaceFlag(tail) || tail.includes("--in-place");
  if (head === "rg") return tail.includes("--replace");
  return false;
}

function xargsSubcommand(tokens) {
  if (tokens[0] !== "xargs") return null;
  for (let i = 1; i < tokens.length;) {
    const token = tokens[i];
    if (token === "--") return tokens.slice(i + 1);
    if (!token.startsWith("-")) return tokens.slice(i);
    const takesValue = new Set(["-E", "-e", "-I", "-L", "-n", "-P", "-s"]).has(token) && token.length === 2;
    i += takesValue ? 2 : 1;
  }
  return null;
}
function xargsHasInPlaceFlag(tokens) {
  return tokens.some((token) => token === "-i" || token.startsWith("-i") || token === "-pi" || token.startsWith("-pi"));
}

export function isSmallFormattingCommand(tokens) {
  if (!tokens.length) return false;
  const [command, ...tail] = tokens;
  if (new Set(["wc", "tr", "cut", "sort", "uniq", "tee", "column", "yes", "printf"]).has(command)) return true;
  if (command === "xargs") return !isMutatingXargsCommand(tokens);
  if (command === "awk") return awkDataFileOperand(tail) == null;
  if (command === "head") {
    if (!tail.length) return true;
    if (tail.length === 1) return tail[0].startsWith("-");
    if (tail.length === 2 && new Set(["-n", "-c"]).has(tail[0]) && /^\d+$/.test(tail[1])) return true;
    return false;
  }
  if (command === "tail") {
    if (!tail.length) return true;
    if (tail.length === 1) return tail[0].startsWith("-");
    if (tail.length === 2 && new Set(["-n", "-c"]).has(tail[0]) && /^\+?\d+$/.test(tail[1])) return true;
    return false;
  }
  if (command === "sed") return sedReadPath(tail) == null;
  return false;
}

function summarizeMainTokens(mainCommand) {
  if (!mainCommand.length) return unknown("");
  const [head, ...tail] = mainCommand;
  if (new Set(["ls", "eza", "exa"]).has(head)) {
    const flags = head === "ls"
      ? ["-I", "-w", "--block-size", "--format", "--time-style", "--color", "--quoting-style"]
      : ["-I", "--ignore-glob", "--color", "--sort", "--time-style", "--time"];
    const path = firstNonFlagOperand(tail, flags);
    return listFiles(shlexJoin(mainCommand), path == null ? null : shortDisplayPath(path));
  }
  if (head === "tree") {
    const path = firstNonFlagOperand(tail, ["-L", "-P", "-I", "--charset", "--filelimit", "--sort"]);
    return listFiles(shlexJoin(mainCommand), path == null ? null : shortDisplayPath(path));
  }
  if (head === "du") {
    const path = firstNonFlagOperand(tail, ["-d", "--max-depth", "-B", "--block-size", "--exclude", "--time-style"]);
    return listFiles(shlexJoin(mainCommand), path == null ? null : shortDisplayPath(path));
  }
  if (new Set(["rg", "rga", "ripgrep-all"]).has(head)) {
    const values = trimAtConnector(tail);
    const hasFilesFlag = values.includes("--files");
    const nonFlags = skipFlagValues(values, ["-g", "--glob", "--iglob", "-t", "--type", "--type-add", "--type-not", "-m", "--max-count", "-A", "-B", "-C", "--context", "--max-depth"])
      .filter((entry) => !entry.startsWith("-"));
    if (hasFilesFlag) return listFiles(shlexJoin(mainCommand), nonFlags[0] == null ? null : shortDisplayPath(nonFlags[0]));
    return search(shlexJoin(mainCommand), nonFlags[0] ?? null, nonFlags[1] == null ? null : shortDisplayPath(nonFlags[1]));
  }
  if (head === "git") {
    if (tail[0] === "grep") return parseGrepLike(mainCommand, tail.slice(1));
    if (tail[0] === "ls-files") {
      const path = firstNonFlagOperand(tail.slice(1), ["--exclude", "--exclude-from", "--pathspec-from-file"]);
      return listFiles(shlexJoin(mainCommand), path == null ? null : shortDisplayPath(path));
    }
    return unknown(shlexJoin(mainCommand));
  }
  if (head === "fd") {
    const [query, path] = parseFdQueryAndPath(tail);
    return query == null ? listFiles(shlexJoin(mainCommand), path) : search(shlexJoin(mainCommand), query, path);
  }
  if (head === "find") {
    const [query, path] = parseFindQueryAndPath(tail);
    return query == null ? listFiles(shlexJoin(mainCommand), path) : search(shlexJoin(mainCommand), query, path);
  }
  if (new Set(["grep", "egrep", "fgrep"]).has(head)) return parseGrepLike(mainCommand, tail);
  if (new Set(["ag", "ack", "pt"]).has(head)) {
    const nonFlags = skipFlagValues(trimAtConnector(tail), ["-G", "-g", "--file-search-regex", "--ignore-dir", "--ignore-file", "--path-to-ignore"])
      .filter((entry) => !entry.startsWith("-"));
    return search(shlexJoin(mainCommand), nonFlags[0] ?? null, nonFlags[1] == null ? null : shortDisplayPath(nonFlags[1]));
  }
  if (head === "cat" || head.toLowerCase() === "get-content") {
    let path = null;
    if (head === "cat") path = singleNonFlagOperand(tail, []);
    else {
      const simple = tail.every((argument) => !argument.startsWith("-") || ["-raw", "-path", "-literalpath"].includes(argument.toLowerCase()));
      if (simple) path = singleNonFlagOperand(tail, []);
      if (path && !/^[\p{L}\p{N} /\\.\-_:]+$/u.test(path)) path = null;
    }
    return path == null ? unknown(shlexJoin(mainCommand)) : read(shlexJoin(mainCommand), path);
  }
  if (new Set(["bat", "batcat"]).has(head)) {
    const path = singleNonFlagOperand(tail, ["--theme", "--language", "--style", "--terminal-width", "--tabs", "--line-range", "--map-syntax"]);
    return path == null ? unknown(shlexJoin(mainCommand)) : read(shlexJoin(mainCommand), path);
  }
  if (head === "less") {
    const path = singleNonFlagOperand(tail, ["-p", "-P", "-x", "-y", "-z", "-j", "--pattern", "--prompt", "--tabs", "--shift", "--jump-target"]);
    return path == null ? unknown(shlexJoin(mainCommand)) : read(shlexJoin(mainCommand), path);
  }
  if (head === "more") {
    const path = singleNonFlagOperand(tail, []);
    return path == null ? unknown(shlexJoin(mainCommand)) : read(shlexJoin(mainCommand), path);
  }
  if (head === "head" || head === "tail") {
    const stripPlus = (value) => String(value).replace(/^\+/, "");
    let validN = false;
    if (tail[0] === "-n") validN = /^\d+$/.test(stripPlus(tail[1] ?? ""));
    else if (tail[0]?.startsWith("-n")) validN = /^\d+$/.test(stripPlus(tail[0].slice(2)));
    if (validN) {
      const candidates = [];
      for (let i = 0; i < tail.length; i += 1) {
        if (i === 0 && tail[i] === "-n" && /^\d+$/.test(stripPlus(tail[i + 1] ?? ""))) { i += 1; continue; }
        candidates.push(tail[i]);
      }
      const path = candidates.find((entry) => !entry.startsWith("-"));
      if (path != null) return read(shlexJoin(mainCommand), path);
    }
    if (tail.length === 1 && !tail[0].startsWith("-")) return read(shlexJoin(mainCommand), tail[0]);
    return unknown(shlexJoin(mainCommand));
  }
  if (head === "awk") {
    const path = awkDataFileOperand(tail);
    return path == null ? unknown(shlexJoin(mainCommand)) : read(shlexJoin(mainCommand), path);
  }
  if (head === "nl") {
    const path = skipFlagValues(tail, ["-s", "-w", "-v", "-i", "-b"]).find((entry) => !entry.startsWith("-"));
    return path == null ? unknown(shlexJoin(mainCommand)) : read(shlexJoin(mainCommand), path);
  }
  if (head === "sed") {
    const path = sedReadPath(tail);
    return path == null ? unknown(shlexJoin(mainCommand)) : read(shlexJoin(mainCommand), path);
  }
  if (isPythonCommand(head)) return pythonWalksFiles(tail) ? listFiles(shlexJoin(mainCommand)) : unknown(shlexJoin(mainCommand));
  return unknown(shlexJoin(mainCommand));
}

function isAbsoluteLike(path) {
  return path.startsWith("/") || /^[A-Za-z]:\\/.test(path) || path.startsWith("\\\\");
}
function joinPaths(base, relative) {
  if (isAbsoluteLike(relative)) return relative;
  if (!base) return relative;
  return `${base.replace(/[\\/]$/, "")}/${relative}`;
}

function toCommandAction(parsed, cwd) {
  if (parsed.type === "read") return {
    type: "read", command: parsed.cmd, name: parsed.name,
    path: joinPaths(cwd, parsed.path),
  };
  if (parsed.type === "list_files") return { type: "listFiles", command: parsed.cmd, path: parsed.path };
  if (parsed.type === "search") return { type: "search", command: parsed.cmd, query: parsed.query, path: parsed.path };
  return { type: "unknown", command: parsed.cmd };
}

export class ShellCommandClassifierService extends Service {
  constructor(ctx) {
    super(ctx, "shellCommandClassifier");
  }

  parse(command) {
    if (Array.isArray(command)) return parseCommand(command);
    return parseCommand(["bash", "-lc", String(command ?? "")]);
  }

  classify(command, { cwd = "/workspace" } = {}) {
    return this.parse(command).map((entry) => toCommandAction(entry, cwd));
  }
}
