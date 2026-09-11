export type BrowserUrl = string & { readonly __brand: "BrowserUrl" };

export class BrowserUrlError extends Error {
  readonly code:
    | "empty"
    | "too-long"
    | "invalid"
    | "credentials"
    | "unsupported-scheme";

  constructor(code: BrowserUrlError["code"], message: string) {
    super(message);
    this.name = "BrowserUrlError";
    this.code = code;
  }
}

const HAS_SCHEME = /^[a-zA-Z][a-zA-Z\d+.-]*:/;
const LOCAL_HOST = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?(?:\/|$)/i;

export function parseBrowserUrl(input: string): BrowserUrl {
  const trimmed = input.trim();
  if (trimmed.length === 0)
    throw new BrowserUrlError("empty", "Enter a web address");
  if (trimmed.length > 8_192)
    throw new BrowserUrlError("too-long", "The web address is too long");

  const candidate = LOCAL_HOST.test(trimmed)
    ? `http://${trimmed}`
    : HAS_SCHEME.test(trimmed)
      ? trimmed
      : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new BrowserUrlError("invalid", "Enter a valid web address");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new BrowserUrlError(
      "unsupported-scheme",
      `The ${parsed.protocol.replace(":", "")} scheme is not supported`,
    );
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new BrowserUrlError(
      "credentials",
      "Credentials are not allowed in a web address",
    );
  }
  return parsed.href as BrowserUrl;
}

export function browserUrlTitle(url: BrowserUrl): string {
  const parsed = new URL(url);
  return parsed.hostname || parsed.href;
}

export function browserUrlDisplayValue(url: BrowserUrl | null): string {
  if (url === null) return "";
  const parsed = new URL(url);
  const value = `${parsed.host}${parsed.pathname}${parsed.search}${parsed.hash}`;
  return value.endsWith("/") && parsed.pathname === "/"
    ? value.slice(0, -1)
    : value;
}
