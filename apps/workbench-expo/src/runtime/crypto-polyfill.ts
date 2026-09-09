import { getRandomValues } from "expo-crypto";

// Protocol dependencies such as BSON observe Web Crypto during module load.
// Expo owns the native entropy source; consumers must not fall back to Math.random.
const root = globalThis as typeof globalThis & { crypto?: Crypto };
if (typeof root.crypto?.getRandomValues !== "function") {
  const crypto = (root.crypto ?? {}) as Crypto;
  Object.defineProperty(crypto, "getRandomValues", {
    configurable: true,
    value: getRandomValues,
  });
  Object.defineProperty(root, "crypto", {
    configurable: true,
    value: crypto,
  });
}
