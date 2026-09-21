import { IndexedDbReplicaClientStorage } from "@opencraft/appserver-replica-storage-web";

export function createReplicaStorage() {
  return new IndexedDbReplicaClientStorage({ databaseName: "vela-workbench-replica" });
}
