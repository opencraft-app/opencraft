import { sealedText } from "@opencraft/secret-storage/sealed";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });

export function encodeCapabilityClaims(claims: readonly unknown[]): string {
  return sealedText.encode(encoder.encode(JSON.stringify(claims)));
}

export function decodeCapabilityClaims(payload: string): unknown {
  return JSON.parse(decoder.decode(sealedText.decode(payload)));
}

export function splitCapabilityToken(token: string) {
  if (token.length > 4096) return null;
  const [payload, signature, ...extra] = token.split(".");
  return payload && signature && !extra.length ? { payload, signature } : null;
}

/** Same credential envelope as the Node signer, using only Web Crypto. */
export async function createWebCapabilityCredentials(raw: Uint8Array) {
  if (raw.byteLength !== 32) throw new Error("Invalid capability signing key");
  const key = await crypto.subtle.importKey("raw", new Uint8Array(raw), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
  return {
    async sign(claims: readonly unknown[]): Promise<string> {
      const payload = encodeCapabilityClaims(claims);
      const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
      return `${payload}.${sealedText.encode(new Uint8Array(signature))}`;
    },
    async verify(token: string): Promise<unknown> {
      const parts = splitCapabilityToken(token);
      if (!parts) return null;
      try {
        const signature = sealedText.decode(parts.signature);
        const signed = await crypto.subtle.verify("HMAC", key, signature, encoder.encode(parts.payload));
        return signed ? decodeCapabilityClaims(parts.payload) : null;
      } catch {
        return null;
      }
    },
  };
}
