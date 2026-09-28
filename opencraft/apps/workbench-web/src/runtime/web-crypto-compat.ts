type CryptoScope = {
  readonly crypto?: Pick<Crypto, "getRandomValues"> & { readonly randomUUID?: () => string };
};

/** `randomUUID` is absent on ordinary HTTP origins; getRandomValues remains available. */
export function installRandomUuidFallback(scope: CryptoScope = globalThis): boolean {
  const crypto = scope.crypto;
  if (typeof crypto?.randomUUID === "function") return false;
  if (typeof crypto?.getRandomValues !== "function") {
    throw new Error("OpenCraft requires a browser with secure random values");
  }
  Object.defineProperty(crypto, "randomUUID", {
    configurable: true,
    value: () => {
      const bytes = crypto.getRandomValues(new Uint8Array(16));
      bytes[6] = (bytes[6]! & 0x0f) | 0x40;
      bytes[8] = (bytes[8]! & 0x3f) | 0x80;
      const hex = Array.from(bytes, value => value.toString(16).padStart(2, "0"));
      return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
    },
  });
  return true;
}

installRandomUuidFallback();
