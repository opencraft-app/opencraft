import { resolve } from "node:path";

export const labScenarioNames = [
  "abort",
  "canonical-session",
  "chat-runtime",
  "concurrency",
  "desktop-resume",
  "history",
  "initialize",
  "pagination",
  "replica-resume",
  "reconnect",
  "reconnect-loop",
  "resume",
  "resume-contract",
  "smoke",
  "suite",
  "timeout",
] as const;

export type LabScenarioName = (typeof labScenarioNames)[number];

export type LabCommand =
  | { kind: "scenario"; name: LabScenarioName }
  | { kind: "request"; method: string; params: unknown };

export interface LabOptions {
  command: LabCommand;
  hostId: string;
  url: string;
  timeoutMs: number;
  limit: number;
  requests: number;
  cycles: number;
  model: string;
  cwd: string;
  identityFile: string;
  prompt: string;
  projectId?: string;
  threadId?: string;
  inboundLatencyMs: number;
  disconnectAfterMs: number;
  recordPath?: string;
  replayPath?: string;
}

export class LabUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LabUsageError";
  }
}

const valueOptions = new Set([
  "--url",
  "--host",
  "--timeout-ms",
  "--limit",
  "--requests",
  "--cycles",
  "--model",
  "--cwd",
  "--identity-file",
  "--prompt",
  "--project-id",
  "--thread",
  "--inbound-latency-ms",
  "--disconnect-after-ms",
  "--record",
  "--replay",
]);

function positiveInteger(value: string | undefined, option: string, allowZero = false): number {
  const number = Number(value);
  if (!Number.isInteger(number) || (allowZero ? number < 0 : number < 1)) {
    throw new LabUsageError(`${option} must be ${allowZero ? "a non-negative" : "a positive"} integer`);
  }
  return number;
}

function isScenario(value: string | undefined): value is LabScenarioName {
  return labScenarioNames.some((name) => name === value);
}

export function parseLabArgs(argv: readonly string[]): LabOptions {
  const flags = new Map<string, string>();
  const positionals: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? "";
    if (!argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }
    if (argument === "--help") throw new LabUsageError(usageText);
    if (!valueOptions.has(argument)) throw new LabUsageError(`Unknown option ${argument}`);
    const value = argv[++index];
    if (value === undefined || value.startsWith("--")) {
      throw new LabUsageError(`Missing value for ${argument}`);
    }
    flags.set(argument, value);
  }

  const verb = positionals[0] ?? "scenario";
  let command: LabCommand;
  if (verb === "scenario") {
    if (positionals.length > 2) {
      throw new LabUsageError(`scenario received unexpected arguments: ${positionals.slice(2).join(" ")}`);
    }
    const name = positionals[1] ?? "smoke";
    if (!isScenario(name)) throw new LabUsageError(`Unknown scenario ${name}`);
    command = { kind: "scenario", name };
  } else if (verb === "request") {
    if (positionals.length > 3) {
      throw new LabUsageError(`request received unexpected arguments: ${positionals.slice(3).join(" ")}`);
    }
    const method = positionals[1];
    if (method === undefined) throw new LabUsageError("request requires an AppServer method");
    const source = positionals[2] ?? "{}";
    try {
      command = { kind: "request", method, params: JSON.parse(source) as unknown };
    } catch (error) {
      throw new LabUsageError(`request params must be JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    throw new LabUsageError(`Unknown command ${verb}`);
  }

  const recordPath = flags.get("--record");
  const replayPath = flags.get("--replay");
  if (recordPath !== undefined && replayPath !== undefined) {
    throw new LabUsageError("--record and --replay are mutually exclusive");
  }

  return {
    command,
    hostId: flags.get("--host") ?? "local",
    url: flags.get("--url") ?? "ws://127.0.0.1:9988/rpc",
    timeoutMs: positiveInteger(flags.get("--timeout-ms") ?? "5000", "--timeout-ms"),
    limit: positiveInteger(flags.get("--limit") ?? "5", "--limit"),
    requests: positiveInteger(flags.get("--requests") ?? "8", "--requests"),
    cycles: positiveInteger(flags.get("--cycles") ?? "3", "--cycles"),
    model: flags.get("--model") ?? "auto",
    cwd: flags.get("--cwd") ?? process.cwd(),
    identityFile: flags.get("--identity-file")
      ?? resolve(process.cwd(), ".opencraft/appserver-lab/canonical-thread.json"),
    prompt: flags.get("--prompt") ?? "Reply with exactly OPENCRAFT_APP_SERVER_OK. Do not use tools.",
    ...(flags.has("--project-id") ? { projectId: flags.get("--project-id") } : {}),
    ...(flags.has("--thread") ? { threadId: flags.get("--thread") } : {}),
    inboundLatencyMs: positiveInteger(
      flags.get("--inbound-latency-ms") ?? "200",
      "--inbound-latency-ms",
      true,
    ),
    disconnectAfterMs: positiveInteger(
      flags.get("--disconnect-after-ms") ?? "20",
      "--disconnect-after-ms",
      true,
    ),
    ...(recordPath === undefined ? {} : { recordPath }),
    ...(replayPath === undefined ? {} : { replayPath }),
  };
}

export const usageText = `appserver-lab — machine-first AppServer SDK smoke harness

Usage:
  npm run lab -- scenario smoke [options]
  npm run lab -- scenario initialize [options]
  npm run lab -- scenario reconnect [options]
  npm run lab -- scenario reconnect-loop [options]
  npm run lab -- scenario resume [--thread <id>] [options]
  npm run lab -- scenario resume-contract [--thread <id>] [options]
  npm run lab -- scenario desktop-resume [--thread <id>] [options]
  npm run lab -- scenario replica-resume [--thread <id>] [options]
  npm run lab -- scenario history [--thread <id>] [options]
  npm run lab -- scenario pagination [options]
  npm run lab -- scenario concurrency [options]
  npm run lab -- scenario timeout [options]
  npm run lab -- scenario abort [options]
  npm run lab -- scenario canonical-session [options]
  npm run lab -- scenario chat-runtime [options]
  npm run lab -- scenario suite [options]
  npm run lab -- request <method> '<json-params>' [options]

Options:
  --url <ws-url>                  default ws://127.0.0.1:9988/rpc
  --host <host-id>                default local
  --timeout-ms <ms>               request timeout, default 5000
  --limit <count>                 thread/list sample size, default 5
  --requests <count>              concurrent request count, default 8
  --cycles <count>                reconnect loop count, default 3
  --model <model-id>              canonical Thread model, default auto
  --cwd <path>                    canonical Thread workspace, default process cwd
  --identity-file <path>          persisted canonical thread.id
  --prompt <text>                 chat-runtime turn input
  --project-id <id>               AppServer project assignment for a new Chat Runtime Thread
  --thread <thread-id>            resume target; defaults to first listed thread
  --inbound-latency-ms <ms>       reconnect fault latency, default 200
  --disconnect-after-ms <ms>      reconnect fault timing, default 20
  --record <path>                 save JSON-RPC frame recording
  --replay <path>                 use a prior frame recording instead of WebSocket
  --help
`;
