import { getRandomValues, randomUUID } from "expo-crypto";
import structuredCloneModule from "@ungap/structured-clone";

type StructuredCloneProvider = typeof globalThis.structuredClone;

/**
 * Metro may expose a CommonJS default export as `{ default: fn }` even when
 * TypeScript sees a callable synthetic default. Normalize that platform
 * boundary once; protocol and projection packages continue to consume the
 * standard global capability without renderer-specific branches.
 */
function resolveStructuredCloneProvider(value: unknown): StructuredCloneProvider {
  let candidate = value;
  for (let depth = 0; depth < 2 && typeof candidate !== "function"; depth += 1) {
    candidate = typeof candidate === "object" && candidate !== null
      ? (candidate as { readonly default?: unknown }).default
      : undefined;
  }
  if (typeof candidate !== "function") {
    throw new TypeError("Native structuredClone provider is not callable");
  }
  return candidate as StructuredCloneProvider;
}

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
if (typeof root.crypto?.randomUUID !== "function") {
  const crypto = (root.crypto ?? {}) as Crypto;
  Object.defineProperty(crypto, "randomUUID", {
    configurable: true,
    value: randomUUID,
  });
  if (root.crypto !== crypto) {
    Object.defineProperty(root, "crypto", {
      configurable: true,
      value: crypto,
    });
  }
}

// React Native Hermes does not currently expose structuredClone. AppServer
// projections use it as a synchronous ownership boundary before publishing
// mutable Turn state, so falling back at individual call sites would weaken
// the same invariant in every adapter and store that runs on native.
if (typeof root.structuredClone !== "function") {
  Object.defineProperty(root, "structuredClone", {
    configurable: true,
    value: resolveStructuredCloneProvider(structuredCloneModule),
  });
}
