import type { TokenizerExtension } from "marked";

// Only complete, multiline JSON is promoted. Never repair or reserialize pasted
// configuration: the code surface and clipboard must retain its original bytes.
function jsonEnd(source: string, opening: number): number {
  const stack: string[] = [];
  let quoted = false;
  let escaped = false;
  for (let index = opening; index < source.length; index++) {
    const character = source[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === "{" || character === "[") stack.push(character);
    else if (character === "}" || character === "]") {
      if (stack.pop() !== (character === "}" ? "{" : "[")) return -1;
      if (stack.length === 0) return index + 1;
    }
  }
  return -1;
}

function candidate(source: string): { prefix: string; code: string; end: number; valid: boolean } | null {
  const line = source.slice(0, source.indexOf("\n") < 0 ? source.length : source.indexOf("\n"));
  const match = /"(?:[^"\\]|\\.)*"[ \t]*:[ \t]*[\[{]|[\[{]/u.exec(line);
  if (!match) return null;
  const prefix = source.slice(0, match.index);
  // Keep explicit Markdown containers, inline code and source-code statements
  // with their existing parser. Plain introductory prose may share the line.
  if (/[`~<>\[\]{}=\\"();]/u.test(prefix)
    || /\b(?:return|throw|yield|export|import)\s*$/u.test(prefix)
    || /^ {0,3}(?:[-+*#]|\d+[.)])[ \t]/u.test(prefix)) return null;
  const member = match[0].startsWith('"');
  const opening = match.index + match[0].length - 1;
  const end = jsonEnd(source, opening);
  const code = source.slice(match.index, end < 0 ? source.length : end);
  const found = { prefix, code, end: end < 0 ? source.length : end, valid: false };
  if (end < 0 || !code.includes("\n") || /^[ \t]*[;)]/u.test(source.slice(end))) return found;
  try { JSON.parse(member ? `{${code}}` : code); } catch { return found; }
  return { ...found, valid: true };
}

export const jsonBlockTokenizer: TokenizerExtension = {
  name: "bareJson",
  level: "block",
  start(source) {
    // Marked already handles fenced/indented code before paragraph lookahead.
    // Restrict lookahead to line boundaries, so inline JSON remains inline.
    if (source.includes("`")) return undefined;
    let offset = source.indexOf("\n");
    while (offset >= 0) {
      offset += 1;
      // Nested indented members must not escape an incomplete outer object.
      const found = source[offset] !== " " && source[offset] !== "\t"
        ? candidate(source.slice(offset)) : null;
      if (found?.valid) return offset;
      // A failed outer structure owns its suffix too. Skip it once rather
      // than rescanning every nested opening in malformed or streaming input.
      if (found) offset += found.end;
      offset = source.indexOf("\n", offset);
    }
    return undefined;
  },
  tokenizer(source) {
    const found = candidate(source);
    if (!found?.valid) return undefined;
    return {
      type: "bareJson",
      raw: source.slice(0, found.end),
      text: found.code,
      prefix: found.prefix,
      tokens: this.lexer.inlineTokens(found.prefix.trimEnd()),
    };
  },
  childTokens: ["tokens"],
};
