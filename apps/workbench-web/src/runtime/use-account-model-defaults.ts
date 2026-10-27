import { beginObservedOperation } from "./observability";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { AccountModelDefaultsRecord, AccountModelSelection } from "@opencraft/workbench-runtime";
import type { PlatformAccountContributionRegistry } from "./platform-account-contributions";

const noSubscribe = () => () => {};

/** Account data stays in memory and on its authenticated server, never browser persistence. */
export function useAccountModelDefaults(accounts: PlatformAccountContributionRegistry, hostId: string, enabled: boolean) {
  const contribution = useSyncExternalStore(accounts.subscribe, accounts.getSnapshot).contribution;
  const getScope = useCallback(() => contribution?.getSnapshot().readStateScope ?? null, [contribution]);
  const scope = useSyncExternalStore(contribution?.subscribe ?? noSubscribe, getScope);
  const getPhase = useCallback(() => contribution?.getSnapshot().phase ?? "anonymous", [contribution]);
  const phase = useSyncExternalStore(contribution?.subscribe ?? noSubscribe, getPhase);
  const port = contribution?.modelDefaults;
  const client = useQueryClient();
  const owner = useMemo(() => ({ controller: new AbortController() }), [contribution, scope, port]);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const [failure, setFailure] = useState<{ owner: object; error: Error } | null>(null);
  useEffect(() => {
    if (owner.controller.signal.aborted) owner.controller = new AbortController();
    return () => { owner.controller.abort(); };
  }, [owner]);
  const keyFor = useCallback((host: string) => ["account-model-defaults", contribution?.id, scope, host] as const, [contribution, scope]);
  const current = useCallback(() => !owner.controller.signal.aborted && accounts.getSnapshot().contribution === contribution
    && scope !== null && getScope() === scope, [accounts, contribution, owner, getScope, scope]);
  const query = useQuery({
    queryKey: keyFor(hostId), enabled: enabled && !!port && scope !== null,
    queryFn: async ({ signal }) => { const finish=beginObservedOperation("configuration_confirmed");try{const result=await port!.read(scope!,hostId,signal);signal.throwIfAborted();if(!current()){finish("aborted");return result;}finish("ok");return result;}catch(error){finish(signal.aborted?"aborted":"failed");throw error;} },
    staleTime: 0, retry: false,
  });
  const remember = useCallback((selection: AccountModelSelection, host: string) => {
    if (!enabled || !port || scope === null || !current()) return;
    const key = keyFor(host);
    queue.current = queue.current.catch(() => undefined).then(async () => {
      if (!current()) return;
      // Reading is needed for a newly selected cross-Agent Host. The server CAS
      // prevents a stale device from overwriting a concurrent personal choice.
      const prior = client.getQueryData<AccountModelDefaultsRecord>(key)
        ?? await port.read(scope, host, owner.controller.signal);
      if (!current()) return;
      await client.cancelQueries({ queryKey: key });
      if (!current()) return;
      const finishSave=beginObservedOperation("preference_save");
      let record;try{record=await port.write(scope,host,prior.revision,selection,owner.controller.signal);finishSave(current()?"ok":"aborted");}catch(error){finishSave(owner.controller.signal.aborted?"aborted":"failed");throw error;}
      if (!current()) return;
      client.setQueryData(key, record);
      setFailure(null);
    }).catch(error => {
      if (!current()) return;
      setFailure({ owner, error: error instanceof Error ? error : new Error(String(error)) });
      void client.invalidateQueries({ queryKey: key });
    });
  }, [enabled, port, scope, current, keyFor, client, owner]);
  return { authoritative: port !== undefined, selection: enabled && scope !== null ? query.data?.selection : null,
    error: !enabled ? null : failure?.owner === owner ? failure.error : query.error,
    isPending: enabled && !!port && (phase === "loading" || scope !== null && query.isPending),
    isFetching: enabled && query.isFetching, remember };
}
