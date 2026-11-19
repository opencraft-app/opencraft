import { useEffect, useRef, useState } from "react";
export function useBlobSource(blob: Blob | undefined, type?: string): string | null {
  const [lease, setLease] = useState<{ blob: Blob; type?: string; url: string } | null>(null);
  useEffect(() => {
    if (!blob) return;
    const url = URL.createObjectURL(type ? blob.slice(0, blob.size, type) : blob);
    setLease({ blob, type, url });
    return () => URL.revokeObjectURL(url);
  }, [blob, type]);
  return lease?.blob === blob && lease?.type === type ? (lease?.url ?? null) : null;
}
/** Both inline messages and file adapters use native controls and one playback lifecycle. */
export function MediaPlayer({
  source,
  blob,
  type,
  kind,
  label,
  active = true,
  className,
  onError,
}: {
  readonly source?: string;
  readonly blob?: Blob;
  readonly type?: string;
  readonly kind: "audio" | "video";
  readonly label?: string;
  readonly active?: boolean;
  readonly className?: string;
  readonly onError?: () => void;
}) {
  const owned = useBlobSource(blob, type);
  const src = blob ? owned : source;
  const element = useRef<HTMLMediaElement | null>(null);
  useEffect(() => {
    const player = element.current;
    if (!player) return;
    const pause = () => player.pause();
    const visibility = () => {
      if (document.visibilityState === "hidden") pause();
    };
    if (!active) pause();
    document.addEventListener("visibilitychange", visibility);
    return () => {
      document.removeEventListener("visibilitychange", visibility);
      pause();
    };
  }, [active, src]);
  if (!src) return null;
  const props = {
    src,
    controls: true,
    preload: "metadata" as const,
    "aria-label": label,
    className,
    onError,
    ref: (node: HTMLMediaElement | null) => {
      element.current = node;
    },
  };
  return kind === "video" ? <video key={src} {...props} /> : <audio key={src} {...props} />;
}
