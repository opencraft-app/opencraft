// Both standalone Hosts and daemon leases share the same persisted identity owner.
export { readHostMachineIdentity as readDaemonMachineIdentity } from "@opencraft/local-agent-host/machine-identity";
