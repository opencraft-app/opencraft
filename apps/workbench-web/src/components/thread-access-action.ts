import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useIntl } from '@opencraft/i18n/react';
import type { ThreadAccessSnapshot } from '@opencraft/appserver-protocol';
import { useAsyncNotices } from './async-notices';

export interface ThreadAccessPort {
  read(): Promise<ThreadAccessSnapshot>;
  set(accessMode: 'shared' | 'private', expectedRevision: number): Promise<ThreadAccessSnapshot>;
}

/** UI only consumes server-computed ownership; it never infers a creator. */
export function useThreadAccessAction(scope: string, threadId: string, port: ThreadAccessPort | undefined, enabled: boolean) {
  const intl = useIntl(), notices = useAsyncNotices(), client = useQueryClient();
  const queryKey = ['thread-access',scope,threadId];
  const query = useQuery({queryKey,queryFn:() => port!.read(), enabled:!!port && !!threadId && enabled, retry:false, gcTime:0, staleTime:0});
  const mutation = useMutation({
    mutationFn: () => port!.set(query.data!.accessMode === 'private' ? 'shared' : 'private',query.data!.revision),
    retry:false,
    onSuccess: value => { client.setQueryData(queryKey,value); },
    onError: () => notices.error({key:`thread-access:${scope}:${threadId}`,message:intl.formatMessage({id:'thread.access.failed',defaultMessage:'Could not change access. Refresh and try again.'})}),
    onSettled: () => client.invalidateQueries({queryKey}),
  });
  if (!enabled || query.isFetching || !query.data?.canChangeAccess) return null;
  return {label:intl.formatMessage(query.data.accessMode === 'private'
    ? {id:'thread.access.share',defaultMessage:'Make shared'}
    : {id:'thread.access.private',defaultMessage:'Make private (only you)'}),
    pending:mutation.isPending, invoke:() => mutation.mutate()};
}
