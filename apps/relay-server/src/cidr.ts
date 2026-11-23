import { isIPv4, isIPv6 } from "node:net";

/** A parsed network: address bytes (4 for IPv4, 16 for IPv6) and prefix length. */
export interface Cidr {
  readonly bytes: Uint8Array;
  readonly prefix: number;
}

function ipv4Bytes(value: string): Uint8Array | null {
  if (!isIPv4(value)) return null;
  return Uint8Array.from(value.split(".").map(Number));
}

function ipv6Bytes(value: string): Uint8Array | null {
  // Zone identifiers name a local interface, not a network, and never match.
  if (!isIPv6(value) || value.includes("%")) return null;
  let text = value,
    tail: number[] = [];
  if (text.includes(".")) {
    // An embedded IPv4 tail supplies the last two groups.
    const colon = text.lastIndexOf(":"),
      embedded = ipv4Bytes(text.slice(colon + 1));
    if (!embedded) return null;
    tail = [(embedded[0]! << 8) | embedded[1]!, (embedded[2]! << 8) | embedded[3]!];
    text = text.slice(0, colon + 1);
    if (!text.endsWith("::")) text = text.slice(0, -1);
  }
  const [head, rest] = text.split("::") as [string, string | undefined];
  const parse = (part: string) => (part ? part.split(":").map((group) => Number.parseInt(group, 16)) : []);
  const left = parse(head),
    right = [...parse(rest ?? ""), ...tail];
  const missing = 8 - left.length - right.length;
  if (rest === undefined ? missing !== 0 : missing < 1) return null;
  const groups = [...left, ...Array<number>(rest === undefined ? 0 : missing).fill(0), ...right];
  const bytes = new Uint8Array(16);
  groups.forEach((group, index) => {
    bytes[index * 2] = group >> 8;
    bytes[index * 2 + 1] = group & 0xff;
  });
  return bytes;
}

/** Normalize a socket address: IPv4-mapped IPv6 is the IPv4 address it carries. */
export function addressBytes(address: string | undefined): Uint8Array | null {
  if (!address) return null;
  const v4 = ipv4Bytes(address);
  if (v4) return v4;
  const v6 = ipv6Bytes(address);
  if (v6 && v6.subarray(0, 10).every((byte) => byte === 0) && v6[10] === 0xff && v6[11] === 0xff) return v6.slice(12);
  return v6;
}

/**
 * Parse `address/prefix` strictly: canonical numeric prefix, no host bits set
 * and no catch-all `/0`, so a typo cannot silently widen the trusted network.
 */
export function parseCidr(value: unknown): Cidr {
  if (typeof value !== "string" || value.length > 64) throw new Error("Invalid CIDR");
  const slash = value.indexOf("/"),
    text = value.slice(0, slash),
    length = value.slice(slash + 1);
  const bytes = slash > 0 ? (isIPv4(text) ? ipv4Bytes(text) : ipv6Bytes(text)) : null;
  if (!bytes || !/^(?:[1-9]\d{0,2})$/u.test(length)) throw new Error("Invalid CIDR");
  const prefix = Number(length);
  if (prefix > bytes.length * 8) throw new Error("Invalid CIDR");
  for (let bit = prefix; bit < bytes.length * 8; bit++) {
    if (bytes[bit >> 3]! & (0x80 >> (bit & 7))) throw new Error("CIDR has host bits set");
  }
  return { bytes, prefix };
}

export function cidrContains(cidr: Cidr, address: Uint8Array) {
  if (address.length !== cidr.bytes.length) return false;
  for (let bit = 0; bit < cidr.prefix; bit++) {
    const mask = 0x80 >> (bit & 7);
    if ((address[bit >> 3]! & mask) !== (cidr.bytes[bit >> 3]! & mask)) return false;
  }
  return true;
}

/** Returns the canonical source address when it is inside one of the networks. */
export function createSourceAllowList(cidrs: readonly string[]) {
  const networks = cidrs.map(parseCidr);
  return (address: string | undefined): string | null => {
    const bytes = addressBytes(address);
    if (!bytes || !networks.some((network) => cidrContains(network, bytes))) return null;
    return bytes.length === 4 ? [...bytes].join(".") : address!.toLowerCase();
  };
}
