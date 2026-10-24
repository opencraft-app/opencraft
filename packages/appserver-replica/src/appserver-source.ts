import type { AppServerClient } from "@opencraft/appserver-client";
import type {
  ReplicaJsonValue,
  ReplicaMutateParams,
} from "@opencraft/appserver-protocol";

import type { ReplicaSource } from "./source";
import { parseEntry, parseSnapshot, validateSyncResponse } from "./validation";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function createAppServerReplicaSource(
  client: AppServerClient,
  scope: string,
): ReplicaSource<ReplicaJsonValue> {
  return {
    scope,
    async sync(cursor, limit) {
      const response = await client.request("replica/sync", { scope, cursor, limit }, {
        priority: "background",
      });
      validateSyncResponse(response, scope);
      return response;
    },
    subscribe(listener) {
      return client.subscribeNotification((notification) => {
        if (notification.method === "replica/entry" && isRecord(notification.params)) {
          const candidate = notification.params.entry;
          if (!isRecord(candidate) || candidate.scope !== scope) return;
          const entry = parseEntry(candidate, scope);
          listener({ kind: "entry", entry });
          return;
        }
        if (notification.method === "replica/snapshot" && isRecord(notification.params)) {
          const candidate = notification.params.snapshot;
          if (!isRecord(candidate) || candidate.scope !== scope) return;
          const snapshot = parseSnapshot(candidate, scope);
          listener({ kind: "snapshot", snapshot });
        }
      });
    },
    async mutate(params: Omit<ReplicaMutateParams, "scope">) {
      return client.request("replica/mutate", { ...params, scope }, { priority: "user-blocking" });
    },
  };
}
