import { ExpoSqliteReplicaClientStorage } from "@opencraft/appserver-replica-storage-expo";

export function createReplicaStorage() {
  return new ExpoSqliteReplicaClientStorage("opencraft-workbench-replica.db");
}
