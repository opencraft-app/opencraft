import { IndexedDbReplicaClientStorage } from "@opencraft/appserver-replica-storage-web";

export function createReplicaStorage() {
  return new IndexedDbReplicaClientStorage({ databaseName: "opencraft-workbench-replica", formerDatabaseName: "vela-workbench-replica" });
}
