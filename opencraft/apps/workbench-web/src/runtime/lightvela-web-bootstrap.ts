export type LightVelaWebBootstrapEnvironment = Readonly<Record<string, unknown>>;

export interface LightVelaWebBootstrapOptions {
  readonly lightVelaApiBase?: string;
  readonly lightVelaRegion?: "cn" | "intl";
}

export interface BrowserProcessTarget {
  process?: { env?: Record<string, unknown> };
}

export function ensureBrowserProcessEnv(target: BrowserProcessTarget): void {
  if (target.process === undefined) {
    target.process = { env: {} };
    return;
  }
  target.process.env ??= {};
}

export function resolveLightVelaWebBootstrapOptions(
  environment: LightVelaWebBootstrapEnvironment,
): LightVelaWebBootstrapOptions {
  const rawApiBase = typeof environment.VITE_LIGHTVELA_API_BASE_URL === "string"
    ? environment.VITE_LIGHTVELA_API_BASE_URL.trim()
    : "";
  let apiBase = "";
  if (rawApiBase !== "") {
    let parsed: URL;
    try {
      parsed = new URL(rawApiBase);
    } catch {
      throw new Error("VITE_LIGHTVELA_API_BASE_URL must be an absolute HTTP(S) origin");
    }
    if (
      (parsed.protocol !== "https:" && parsed.protocol !== "http:")
      || parsed.username !== ""
      || parsed.password !== ""
      || parsed.pathname !== "/"
      || parsed.search !== ""
      || parsed.hash !== ""
    ) {
      throw new Error("VITE_LIGHTVELA_API_BASE_URL must be an absolute HTTP(S) origin");
    }
    apiBase = parsed.origin;
  }
  const region = typeof environment.VITE_LIGHTVELA_REGION === "string"
    ? environment.VITE_LIGHTVELA_REGION.trim()
    : "";

  if (region !== "" && region !== "cn" && region !== "intl") {
    throw new Error("VITE_LIGHTVELA_REGION must be cn or intl");
  }

  return {
    ...(apiBase === "" ? {} : { lightVelaApiBase: apiBase }),
    ...(region === "" ? {} : { lightVelaRegion: region }),
  };
}
