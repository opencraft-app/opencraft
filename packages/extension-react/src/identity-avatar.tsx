import { createContext, useCallback, useState, type ReactNode } from "react";

export const IDENTITY_AVATAR_CHANNEL = "identityAvatar";
/** Products resolve identity photos; the Shell owns layout and fallback rendering. */
export interface IdentityAvatarContribution {
  readonly id: string;
  resolve(kind: string, name: string): string | null;
}
export const IdentityAvatarContext = createContext<IdentityAvatarContribution | null>(null);

/** Missing/failed photos use the caller's fallback, not photos still loading. */
export function AvatarImage({ src, fallback }: { src: string | null; fallback: ReactNode }) {
  return src ? <AvatarPhoto key={src} src={src} fallback={fallback} /> : fallback;
}

function AvatarPhoto({ src, fallback }: { src: string; fallback: ReactNode }) {
  const [ready, setReady] = useState<boolean | null>(false);
  const settle = useCallback((image: HTMLImageElement | null) => {
    // Cached photos may already be complete before React attaches onLoad.
    if (!image?.complete) return;
    if (image.naturalWidth > 0) {
      setReady(true);
    } else {
      setReady(null);
    }
  }, [src]);
  if (ready === null) return fallback;
  return <img
    ref={settle}
    src={src}
    alt=""
    referrerPolicy="no-referrer"
    // Keep the image's normal geometry without briefly impersonating a missing
    // portrait. The caller's existing avatar surface is the loading placeholder.
    style={ready ? undefined : { visibility: "hidden" }}
    onLoad={event => settle(event.currentTarget)}
    onError={event => settle(event.currentTarget)}
  />;
}
