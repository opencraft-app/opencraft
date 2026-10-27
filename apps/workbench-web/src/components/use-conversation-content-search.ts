import { useEffect, useRef, useState } from "react";
import { isUnsupportedSearch, type ConversationSearchRow, type ConversationSearchSource } from "../runtime/conversation-content-search";

export interface ContentSearchState {
  readonly source: ConversationSearchSource;
  readonly phase: "loading" | "ready" | "error" | "unsupported" | "unavailable";
  readonly matches: readonly ConversationSearchRow[];
  readonly cursor: string | null;
  readonly seen: readonly string[];
}

export function useConversationContentSearch(term: string, sources: readonly ConversationSearchSource[]) {
  const [state, setState] = useState<{ term: string; sources: typeof sources; rows: readonly ContentSearchState[] } | null>(null);
  const controller = useRef<AbortController | null>(null);
  const read = async (source: ConversationSearchSource, cursor: string | null, signal: AbortSignal) => {
    const update = (apply: (row: ContentSearchState) => ContentSearchState) => {
      if (signal.aborted) return;
      setState(current => current?.term === term && current.sources === sources ? {
        ...current, rows: current.rows.map(row => row.source === source ? apply(row) : row),
      } : current);
    };
    update(row => ({ ...row, phase: "loading" }));
    try {
      const page = await source.search(term, cursor, signal);
      update(row => {
        if (page.nextCursor !== null && (page.nextCursor === cursor || row.seen.includes(page.nextCursor))) {
          return { ...row, phase: "error" };
        }
        const merged = new Map((cursor === null ? [] : row.matches).map(match => [match.id, match]));
        for (const match of page.matches) merged.set(match.id, match);
        return { ...row, phase: "ready", matches: [...merged.values()], cursor: page.nextCursor,
          seen: [...row.seen, ...(cursor === null ? [] : [cursor])] };
      });
    } catch (error) {
      update(row => ({ ...row, phase: isUnsupportedSearch(error) ? "unsupported" : "error" }));
    }
  };
  useEffect(() => {
    const abort = new AbortController(); controller.current = abort;
    const rows: ContentSearchState[] = term ? sources.map(source => ({ source, phase: !source.available ? "unavailable" : source.supported === false ? "unsupported" : "loading", matches: [], cursor: null, seen: [] })) : [];
    setState({ term, sources, rows });
    const timer = setTimeout(() => {
      for (const row of rows) if (row.phase === "loading") void read(row.source, null, abort.signal);
    }, 300);
    return () => { clearTimeout(timer); abort.abort(); };
  }, [term, sources]);
  const rows = state?.term === term && state.sources === sources ? state.rows : [];
  return { rows, pending: !!term && (state?.term !== term || state.sources !== sources || rows.some(row => row.phase === "loading")),
    load: (row: ContentSearchState) => {
      const signal = controller.current?.signal;
      if (signal && row.phase !== "loading") void read(row.source, row.cursor, signal);
    } };
}
