import { execFile } from "node:child_process";
import { networkInterfaces } from "node:os";
import { promisify } from "node:util";
import { validateDirectRouteCandidate, type DirectRouteCandidate } from "@opencraft/relay-protocol";

const execFileAsync = promisify(execFile);

export interface DirectRouteDiscoveryOptions {
  readonly localPort?: number;
  readonly localProtocol?: "http" | "https";
  readonly includeTailscale?: boolean;
  readonly networkInterfacesImpl?: typeof networkInterfaces;
  readonly execTailscaleStatusJson?: () => Promise<unknown>;
}

function isLanPrivateIpv4(address: string): boolean {
  const parts = address.split(".");
  if (parts.length !== 4 || parts.some((p) => !/^(?:0|[1-9]\d{0,2})$/u.test(p))) return false;
  const [a, b] = parts.map(Number) as [number, number, number, number];
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

function isTailnetCgnatIpv4(address: string): boolean {
  const parts = address.split(".");
  if (parts.length !== 4 || parts.some((p) => !/^(?:0|[1-9]\d{0,2})$/u.test(p))) return false;
  const [a, b] = parts.map(Number) as [number, number, number, number];
  return a === 100 && b >= 64 && b <= 127;
}

async function defaultTailscaleStatusJson(): Promise<unknown> {
  const { stdout } = await execFileAsync("tailscale", ["status", "--json"], {
    timeout: 2_500,
    maxBuffer: 1024 * 1024,
  });
  return JSON.parse(stdout);
}

/**
 * Discovers direct LAN and Tailscale routes asynchronously (zero blocking sync IO)
 * so same-network or same-Tailnet devices can bypass the cloud relay data plane.
 */
export async function discoverDirectRoutes(
  options: DirectRouteDiscoveryOptions = {},
): Promise<readonly DirectRouteCandidate[]> {
  const candidates = new Map<string, DirectRouteCandidate>();
  const protocol = options.localProtocol ?? "http";
  const hasPort =
    options.localPort !== undefined &&
    Number.isInteger(options.localPort) &&
    options.localPort >= 1 &&
    options.localPort <= 65_535;

  const addCandidate = (raw: DirectRouteCandidate) => {
    try {
      const validated = validateDirectRouteCandidate(raw);
      const existing = candidates.get(validated.origin);
      if (!existing || validated.priority < existing.priority) {
        candidates.set(validated.origin, validated);
      }
    } catch {
      // Ignore malformed OS/Tailscale interface entries rather than failing discovery.
    }
  };

  if (options.includeTailscale !== false) {
    try {
      const status = (await (options.execTailscaleStatusJson ?? defaultTailscaleStatusJson)()) as {
        BackendState?: unknown;
        CertDomains?: unknown;
        Self?: { Online?: unknown; DNSName?: unknown; TailscaleIPs?: unknown };
      } | null;
      if (status && status.BackendState === "Running" && status.Self?.Online !== false) {
        const certDomains = Array.isArray(status.CertDomains)
          ? status.CertDomains.filter(
              (d): d is string => typeof d === "string" && d.replace(/\.$/u, "").toLowerCase().endsWith(".ts.net"),
            )
          : [];
        for (const domain of certDomains) {
          const cleanHost = domain.replace(/\.$/u, "").toLowerCase();
          addCandidate({
            kind: "tailscale",
            origin: `https://${cleanHost}`,
            priority: 10,
          });
        }
        if (hasPort && Array.isArray(status.Self?.TailscaleIPs)) {
          for (const ip of status.Self.TailscaleIPs) {
            if (typeof ip === "string" && isTailnetCgnatIpv4(ip)) {
              addCandidate({
                kind: "tailscale",
                origin: `${protocol}://${ip}:${options.localPort}`,
                priority: 15,
              });
            }
          }
        }
      }
    } catch {
      // Tailscale CLI is optional on user machines; absence is expected and non-fatal.
    }
  }

  if (hasPort) {
    const interfaces = (options.networkInterfacesImpl ?? networkInterfaces)();
    for (const entries of Object.values(interfaces)) {
      if (!entries) continue;
      for (const entry of entries) {
        if (entry.internal || entry.family !== "IPv4") continue;
        if (isLanPrivateIpv4(entry.address)) {
          addCandidate({
            kind: "lan",
            origin: `${protocol}://${entry.address}:${options.localPort}`,
            priority: 20,
          });
        } else if (isTailnetCgnatIpv4(entry.address)) {
          addCandidate({
            kind: "tailscale",
            origin: `${protocol}://${entry.address}:${options.localPort}`,
            priority: 15,
          });
        }
      }
    }
  }

  return [...candidates.values()].sort((a, b) => a.priority - b.priority || a.origin.localeCompare(b.origin));
}
