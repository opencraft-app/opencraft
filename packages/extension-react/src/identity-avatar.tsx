import { createContext, useState, type ReactNode } from "react";

export const IDENTITY_AVATAR_CHANNEL = "identityAvatar";
/** Products resolve identity photos; the Shell owns layout and fallback rendering. */
export interface IdentityAvatarContribution {
  readonly id: string;
  resolve(kind: string, name: string): string | null;
}
export const IdentityAvatarContext = createContext<IdentityAvatarContribution | null>(null);

/** Keep the caller's fallback until the current photo has actually loaded. */
export function AvatarImage({ src, fallback }: { src: string | null; fallback: ReactNode }) {
  return src ? <AvatarPhoto key={src} src={src} fallback={fallback} /> : <>{fallback}</>;
}

function AvatarPhoto({ src, fallback }: { src: string; fallback: ReactNode }) {
  const [phase, setPhase] = useState<"loading" | "loaded" | "failed">("loading");
  return <>
    {phase !== "loaded" ? fallback : null}
    {phase !== "failed" ? <img
      src={src}
      alt=""
      referrerPolicy="no-referrer"
      style={phase === "loaded" ? undefined : { display: "none" }}
      onLoad={event => setPhase(event.currentTarget.naturalWidth > 0 ? "loaded" : "failed")}
      onError={() => setPhase("failed")}
    /> : null}
  </>;
}
