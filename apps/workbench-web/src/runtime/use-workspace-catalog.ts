import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAppServerRuntime, useAppServerHostSnapshot } from './appserver-runtime-context';
import { canReadWorkspaceCatalog, workspaceCatalogOptions } from './workspace-catalog-query';

export function useWorkspaceCatalog() {
  const runtime = useAppServerRuntime();
  const snapshot = useAppServerHostSnapshot();
  const client = useQueryClient();
  const options = workspaceCatalogOptions(runtime);
  const query = useQuery(options);
  const available = canReadWorkspaceCatalog(runtime);
  // Cancel on disconnect, Host replacement and unmount, even without recovery bindings.
  useEffect(() => {
    const filters = { queryKey: options.queryKey, exact: true };
    if (!available) void client.cancelQueries(filters);
    return () => { void client.cancelQueries(filters); };
  }, [client, runtime, snapshot.hostId, snapshot.connectionGeneration, available]);
  const data = query.data?.owner === runtime ? query.data.data : undefined;
  return { data, available, loading: query.isFetching, error: query.error,
    selectable: available && !!data && !query.isError && !query.isFetching,
    refresh: () => { if (canReadWorkspaceCatalog(runtime)) void query.refetch(); } };
}
