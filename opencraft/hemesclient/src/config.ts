export interface Config {
  gatewayUrl: string;
  gatewayToken?: string;
  listenHost: string;
  listenPort: number;
  timeoutMs: number;
  defaultCwd: string;
}

function readFlag(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

export function loadConfig(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): Config {
  const gatewayUrl = readFlag(argv, "--gateway") ?? env.HERMES_GATEWAY_URL ?? "http://127.0.0.1:9119";
  const parsed = new URL(gatewayUrl);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Hermes Gateway URL must use http or https");
  }
  return {
    gatewayUrl: parsed.toString().replace(/\/$/u, "").replace(/\/api$/u, ""),
    gatewayToken: readFlag(argv, "--token") ?? env.HERMES_GATEWAY_TOKEN,
    listenHost: readFlag(argv, "--host") ?? env.HEMESCLIENT_HOST ?? "0.0.0.0",
    listenPort: positiveInteger(readFlag(argv, "--port") ?? env.HEMESCLIENT_PORT, 9989, "port"),
    timeoutMs: positiveInteger(readFlag(argv, "--timeout") ?? env.HEMESCLIENT_TIMEOUT_MS, 30_000, "timeout"),
    defaultCwd: readFlag(argv, "--cwd") ?? env.HEMESCLIENT_DEFAULT_CWD ?? "/",
  };
}
