import { useCallback, useEffect, useState, type DependencyList } from "react";

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

  const run = useCallback(async () => {
    setState((current) => ({ ...current, loading: true, error: null }));
    try {
      const data = await fetcher();
      setState({ loading: false, error: null, data });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unexpected error";
      setState({ loading: false, error: message, data: null });
    }
  }, [fetcher]);

  useEffect(() => {
    void run();
  }, deps);

  return {
    ...state,
    reload: run,
  };
};
