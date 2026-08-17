export function installTuiRuntimeGlobals(): void {
  if (typeof globalThis.URL === "undefined") {
    Object.defineProperty(globalThis, "URL", {
      configurable: true,
      value: TuiURL,
      writable: true,
    });
  }
  if (typeof globalThis.AbortController === "undefined") {
    Object.defineProperty(globalThis, "AbortController", {
      configurable: true,
      value: TuiAbortController,
      writable: true,
    });
  }
  if (typeof globalThis.Headers === "undefined") {
    Object.defineProperty(globalThis, "Headers", {
      configurable: true,
      value: TuiHeaders,
      writable: true,
    });
  }
}

class TuiHeaders {
  private readonly values = new Map<string, {name: string; value: string}>();

  public constructor(input?: HeadersInit) {
    if (!input) return;
    if (Array.isArray(input)) {
      for (const [name, value] of input) this.set(name, value);
      return;
    }
    if (typeof input === "object" && "forEach" in input) {
      (input as Headers).forEach((value, name) => this.set(name, value));
      return;
    }
    for (const [name, value] of Object.entries(input)) this.set(name, value);
  }

  public entries(): IterableIterator<[string, string]> {
    return Array.from(this.values.values(), ({name, value}) => [name, value] as [string, string])
      .values();
  }

  public forEach(callback: (value: string, name: string) => void): void {
    for (const {name, value} of this.values.values()) callback(value, name);
  }

  public get(name: string): string | null {
    return this.values.get(name.toLowerCase())?.value ?? null;
  }

  private set(name: string, value: string): void {
    this.values.set(name.toLowerCase(), {name, value: String(value)});
  }
}

class TuiURL {
  public hash: string;
  public password = "";
  public pathname: string;
  public protocol: string;
  public search: string;
  public username = "";
  private readonly authority: string;

  public constructor(input: string) {
    const match = input.match(
      /^(https?):\/\/([^/?#]+)(\/[^?#]*)?(\?[^#]*)?(#.*)?$/u,
    );
    if (!match) throw new TypeError("Invalid URL");
    this.protocol = `${match[1]}:`;
    this.authority = match[2] ?? "";
    this.pathname = match[3] || "/";
    this.search = match[4] || "";
    this.hash = match[5] || "";
    const credentialsEnd = this.authority.lastIndexOf("@");
    if (credentialsEnd >= 0) {
      const credentials = this.authority.slice(0, credentialsEnd).split(":");
      this.username = credentials[0] ?? "";
      this.password = credentials.slice(1).join(":");
    }
  }

  public toString(): string {
    return `${this.protocol}//${this.authority}${this.pathname}${this.search}${this.hash}`;
  }
}

class TuiAbortSignal {
  public aborted = false;
  private readonly listeners = new Set<() => void>();

  public addEventListener(
    type: string,
    listener: () => void,
    _options?: {once?: boolean},
  ): void {
    if (type === "abort") this.listeners.add(listener);
  }

  public abort(): void {
    if (this.aborted) return;
    this.aborted = true;
    for (const listener of this.listeners) listener();
    this.listeners.clear();
  }
}

class TuiAbortController {
  public readonly signal = new TuiAbortSignal();

  public abort(): void {
    this.signal.abort();
  }
}
