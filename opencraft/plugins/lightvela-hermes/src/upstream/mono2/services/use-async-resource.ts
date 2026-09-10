// @ts-nocheck -- mechanically vendored from mono2; typechecked in its source repository.
import { useCallback, useEffect, useRef, useState, type DependencyList } from "react";

interface AsyncResourceState<T> {
  loading: boolean;
  error: string | null;
  data: T | null;
}

export const useAsyncResource = <T,>(
  fetcher: () => Promise<T>,
  deps: DependencyList,
): AsyncResourceState<T> & { reload: () => Promise<void> } => {
  const [state, setState] = useState<AsyncResourceState<T>>({
    loading: true,
    error: null,
    data: null,
  });
  const mountedRef = useRef(true);
  const requestIdRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const run = useCallback(async () => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;

    if (!mountedRef.current) {
      return;
    }

    setState((current) => ({ ...current, loading: true, error: null }));
    try {
      const data = await fetcher();
      if (!mountedRef.current || requestId !== requestIdRef.current) {
        return;
      }
      setState({ loading: false, error: null, data });
    } catch (error) {
      if (!mountedRef.current || requestId !== requestIdRef.current) {
        return;
      }
      const message = error instanceof Error ? error.message : "Unexpected error";
      setState({ loading: false, error: message, data: null });
    }
  }, [fetcher]);

  useEffect(() => {
    void run();
  }, [run, ...deps]);

  return {
    ...state,
    reload: run,
  };
};
