import * as Clipboard from "expo-clipboard";
import { useCallback, useEffect, useRef, useState } from "react";

/** Ignore clipboard completions and timers from a previous node or an unmounted surface. */
export function useCopyFeedback(value: string, durationMs: number) {
  const [copied, setCopied] = useState(false);
  const generation = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    generation.current += 1;
    setCopied(false);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    return () => {
      generation.current += 1;
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
    };
  }, [value]);

  const copy = useCallback(() => {
    const request = ++generation.current;
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    void Clipboard.setStringAsync(value).then(() => {
      if (generation.current !== request) return;
      setCopied(true);
      timer.current = setTimeout(() => {
        if (generation.current === request) setCopied(false);
        timer.current = null;
      }, durationMs);
    }).catch(() => {
      if (generation.current === request) setCopied(false);
    });
  }, [durationMs, value]);

  return { copied, copy };
}
