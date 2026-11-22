import { openTerminalAdmission } from "../../apps/local-agent-host/src/terminal-admission-owner.js";
const owner = await openTerminalAdmission(process.argv[2]!);
for (let i = 0; i < 16; i++) await owner.reserve("remote", "actor-host:alice", "uncertain-resource", "op-" + i);
process.send?.({ ready: true });
process.on("message", () => {});
