import { useCallback, useInsertionEffect, useRef } from "react";

export type EventCallback = (...arguments_: never[]) => unknown;

/**
 * Keeps one command identity for the lifetime of a mounted component while
 * dispatching to the implementation from the latest committed render.
 *
 * This is the recovered Codex callback contract used at observer, layout and
 * transport boundaries. Updating the implementation must not itself retrigger
 * an effect which consumes the command.
 */
export function useStableEvent<TCallback extends EventCallback>(
  callback: TCallback,
): TCallback {
  const callbackRef = useRef(callback);

  useInsertionEffect(() => {
    callbackRef.current = callback;
  }, [callback]);

  return useCallback(((...arguments_: Parameters<TCallback>) => (
    callbackRef.current(...arguments_)
  )) as TCallback, []);
}
