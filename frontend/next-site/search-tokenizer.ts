const CJK_PATTERN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;
const LATIN_PATTERN = /[a-z0-9][a-z0-9_-]*/gi;

function collectLatinTokens(input: string, tokens: Set<string>) {
  for (const match of input.matchAll(LATIN_PATTERN)) {
    const token = match[0].toLowerCase();

    tokens.add(token);

    if (token.length > 3 && token.endsWith('s')) {
      tokens.add(token.slice(0, -1));
    }
  }
}

function collectCjkTokens(input: string, tokens: Set<string>) {
  for (const match of input.matchAll(CJK_PATTERN)) {
    const text = match[0];

    for (const char of Array.from(text)) {
      tokens.add(char);
    }

    for (let index = 0; index < text.length - 1; index += 1) {
      tokens.add(text.slice(index, index + 2));
    }

    if (text.length > 2) {
      tokens.add(text);
    }
  }
}

export function createLightVelaSearchTokenizer() {
  return {
    language: 'lightvela',
    normalizationCache: new Map<string, string>(),
    tokenize(raw: string) {
      const tokens = new Set<string>();

      collectLatinTokens(raw, tokens);
      collectCjkTokens(raw, tokens);

      return Array.from(tokens);
    },
  };
}
