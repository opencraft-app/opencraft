/**
 * LightVela backend base for IM (the collaboration API behind the gateway), e.g. `/v1/collaboration` on the same
 * origin. Empty means this deployment has no IM backend, so Agent group chats stay hidden.
 */
export const resolveVelaImApiBase = (): string | null => {
  const raw = (process.env.NEXT_PUBLIC_VELA_IM_API_BASE ?? "").trim().replace(/\/$/, "");
  if (!raw) return null;
  if (raw.startsWith("/")) return typeof window === "undefined" ? raw : `${window.location.origin}${raw}`;
  return /^https?:\/\//.test(raw) ? raw : null;
};

export const isVelaImEnabled = (): boolean => resolveVelaImApiBase() !== null;
