import { createContext, useContext, useLayoutEffect, useMemo, useRef, type UIEvent } from "react";

export interface ChatReadingPosition {
  readonly scrollLeft: number;
  readonly scrollTop: number;
  readonly sourceLength: number;
  readonly sourceHash: number;
}

/** The owning View supplies and checkpoints this map; documents never persist it globally. */
export const ChatReadingPositionContext = createContext<Map<string, ChatReadingPosition> | null>(null);

function hashSource(source: string): number {
  let hash = 2166136261;
  for (let i = 0; i < source.length; i++) hash = Math.imul(hash ^ source.charCodeAt(i), 16777619);
  return hash >>> 0;
}

export function useChatReadingPosition(key: string | undefined, source: string) {
  const positions = useContext(ChatReadingPositionContext);
  const ref = useRef<HTMLDivElement>(null);
  const signature = useMemo(() => positions === null || key === undefined ? null : ({
    sourceLength: source.length, sourceHash: hashSource(source),
  }), [key, positions, source]);
  const committed = useRef(signature);
  useLayoutEffect(() => { committed.current = signature; });
  const remember = (element: HTMLElement) => {
    if (key !== undefined && positions !== null && committed.current !== null) {
      if (element.scrollLeft === 0 && element.scrollTop === 0) {
        positions.delete(key);
        return;
      }
      positions.set(key, { ...committed.current, scrollLeft: element.scrollLeft, scrollTop: element.scrollTop });
    }
  };
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null || positions === null || key === undefined) return;
    const saved = positions.get(key);
    if (saved !== undefined) {
      // A stable node can receive a replacement source. Only the same source or its append is compatible.
      if (saved.sourceLength <= source.length && hashSource(source.slice(0, saved.sourceLength)) === saved.sourceHash) {
        element.scrollLeft = saved.scrollLeft;
        element.scrollTop = saved.scrollTop;
      } else positions.delete(key);
    }
    // Read the live element while it is attached, even when a scroll event is still queued.
    return () => remember(element);
  }, [key, positions]);
  return { ref, onScroll: (event: UIEvent<HTMLDivElement>) => remember(event.currentTarget) };
}
