/**
 * Command and callback method names for the bridge wire. This is a name
 * registry only; capability gating lives in `capabilities.ts`. Names are tied
 * to the protocol version, not to a plugin's own version.
 */

export const BRIDGE_COMMANDS = Object.freeze({
  initialize: "initialize",
  modelList: "model/list",
  sessionCreate: "session/create",
  sessionResume: "session/resume",
  sessionClose: "session/close",
  turnStart: "turn/start",
  turnSteer: "turn/steer",
  turnStop: "turn/stop",
  inputQuery: "input/query",
  inputWithdraw: "input/withdraw",
  interactionResolve: "interaction/resolve",
  historyRead: "history/read",
  maintenanceProbe: "maintenance/probe",
  skillsConfigure: "skills/configure",
  installationStatus: "installation/status",
  installationRun: "installation/run",
} as const);

export const BRIDGE_CALLBACKS = Object.freeze({
  threadDelta: "thread/delta",
  threadIdentity: "thread/identity",
  interactionRequest: "interaction/request",
  providerRecovery: "provider/recovery",
} as const);

export type BridgeCommand = (typeof BRIDGE_COMMANDS)[keyof typeof BRIDGE_COMMANDS];
export type BridgeCallback = (typeof BRIDGE_CALLBACKS)[keyof typeof BRIDGE_CALLBACKS];

const COMMAND_SET: ReadonlySet<string> = new Set<string>(Object.values(BRIDGE_COMMANDS));
const CALLBACK_SET: ReadonlySet<string> = new Set<string>(Object.values(BRIDGE_CALLBACKS));

export function isBridgeCommand(method: string): method is BridgeCommand {
  return COMMAND_SET.has(method);
}

export function isBridgeCallback(method: string): method is BridgeCallback {
  return CALLBACK_SET.has(method);
}

/** A capability declared by a bridge; a command may require exactly one. */
export type CapabilityKey =
  | "model"
  | "reasoning"
  | "history"
  | "usage"
  | "approval"
  | "inputContentTypes"
  | "cliExecutable"
  | "forkCheckpoint"
  | "skills"
  | "installation"
  | "steer";

/**
 * Which declared capability gates each command. `null` marks a core command
 * that any started bridge must serve. A command sent without its capability is
 * refused with `unsupported`; it is never silently downgraded or re-routed.
 */
export const BRIDGE_COMMAND_REQUIREMENTS: Readonly<Record<BridgeCommand, CapabilityKey | null>> = Object.freeze({
  "initialize": null,
  "model/list": "model",
  "session/create": null,
  "session/resume": "history",
  "session/close": null,
  "turn/start": null,
  "turn/steer": "steer",
  "turn/stop": null,
  "input/query": "steer",
  "input/withdraw": "steer",
  "interaction/resolve": "approval",
  "history/read": "history",
  "maintenance/probe": null,
  "skills/configure": "skills",
  "installation/status": "installation",
  "installation/run": "installation",
});
