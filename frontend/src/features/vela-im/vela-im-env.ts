import { isGlobal } from "@/lib/region";
import type { LightVelaRegion } from "@vela/im-client";

/**
 * Vela IM identity service base URL, e.g. `/vela-im` behind the same origin. Empty means this
 * deployment has no IM service, so the lab entry stays hidden.
 */
export const resolveVelaImApiBase = (): string | null => {
  const raw = (process.env.NEXT_PUBLIC_VELA_IM_API_BASE ?? "").trim().replace(/\/$/, "");
  if (!raw) return null;
  if (raw.startsWith("/")) return typeof window === "undefined" ? raw : `${window.location.origin}${raw}`;
  return /^https?:\/\//.test(raw) ? raw : null;
};

export const isVelaImEnabled = (): boolean => resolveVelaImApiBase() !== null;

/** LightVela region whose session token the identity service verifies. */
export const velaImRegion = (): LightVelaRegion => (isGlobal ? "intl" : "cn");
