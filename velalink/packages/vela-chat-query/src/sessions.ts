"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import type {
  ArchiveSessionInput,
  ArchiveSessionWireResponse,
  SessionListOptions,
  SessionListViewWireResponse,
  VeladClient,
} from "../../vela-chat-client/src";
import { velaQueryKeys } from "./queryKeys";

export interface UseSessionListViewQueryOptions {
  client: VeladClient;
  options?: SessionListOptions;
}

export function useSessionListViewQuery({
  client,
  options = {},
}: UseSessionListViewQueryOptions) {
  return useQuery({
    queryKey: velaQueryKeys.sessionListView(options),
    queryFn: () => client.getSessionListView(options),
  });
}

export interface UseArchiveSessionMutationOptions {
  client: VeladClient;
  currentSessionId?: string | null;
  sessionListOptions?: SessionListOptions;
  onSelectSession?: (sessionId: string) => void;
}

interface ArchiveSessionRollback {
  previousListView?: SessionListViewWireResponse;
}

export function useArchiveSessionMutation({
  client,
  currentSessionId = null,
  sessionListOptions = {},
  onSelectSession,
}: UseArchiveSessionMutationOptions) {
  const queryClient = useQueryClient();
  const listKey = velaQueryKeys.sessionListView(sessionListOptions);

  return useMutation<
    ArchiveSessionWireResponse,
    Error,
    ArchiveSessionInput,
    ArchiveSessionRollback
  >({
    mutationFn: (input) => client.archiveSession(input),
    onMutate: async ({ sessionId }) => {
      await queryClient.cancelQueries({ queryKey: listKey });
      const previousListView =
        queryClient.getQueryData<SessionListViewWireResponse>(listKey);
      const nextListView = previousListView
        ? projectArchivedSession(previousListView, sessionId)
        : undefined;

      if (nextListView) {
        queryClient.setQueryData(listKey, nextListView);
        if (currentSessionId === sessionId) {
          const nextSessionId = nextListView.sessions[0]?.id;
          if (nextSessionId) onSelectSession?.(nextSessionId);
        }
      }

      return { previousListView };
    },
    onError: (_err, _input, context) => {
      if (context?.previousListView) {
        queryClient.setQueryData(listKey, context.previousListView);
      }
    },
    onSuccess: (response, { sessionId }) => {
      queryClient.setQueryData(velaQueryKeys.session(sessionId), {
        session: response.session,
      });
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: listKey });
    },
  });
}

export function projectArchivedSession(
  listView: SessionListViewWireResponse,
  sessionId: string,
): SessionListViewWireResponse {
  return {
    ...listView,
    sessions: listView.sessions.filter((session) => session.id !== sessionId),
  };
}

export function readSessionListViewFromCache(
  queryClient: QueryClient,
  options: SessionListOptions = {},
) {
  return queryClient.getQueryData<SessionListViewWireResponse>(
    velaQueryKeys.sessionListView(options),
  );
}

