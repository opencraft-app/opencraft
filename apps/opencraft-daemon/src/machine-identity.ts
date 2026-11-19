// Both standalone Hosts and daemon leases share the same persisted identity owner.
export { readHostMachineIdentity as readDaemonMachineIdentity } from "../../local-agent-host/src/machine-identity.js";
