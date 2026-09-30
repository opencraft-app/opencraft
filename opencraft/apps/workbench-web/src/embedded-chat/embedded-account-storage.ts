import { LIGHTVELA_TOKEN_KEY } from "@opencraft/plugin-lightvela-platform";

/** Borrow the console credential; keep OpenCraft account metadata ephemeral. */
export function createEmbeddedAccountStorage(
  getSessionToken: () => string | null,
): Pick<Storage, "getItem" | "setItem" | "removeItem"> {
  const metadata = new Map<string, string>();
  let revoked = false;
  return {
    getItem(key) {
      if (key !== LIGHTVELA_TOKEN_KEY) return metadata.get(key) ?? null;
      if (revoked) return null;
      const token = getSessionToken()?.trim();
      if (!token) throw new Error("Embedded Chat requires an active console session");
      return token;
    },
    setItem(key, value) {
      if (key === LIGHTVELA_TOKEN_KEY) {
        throw new Error("The console owns the embedded session");
      }
      metadata.set(key, value);
    },
    removeItem(key) {
      if (key === LIGHTVELA_TOKEN_KEY) revoked = true;
      else metadata.delete(key);
    },
  };
}
