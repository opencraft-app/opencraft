/** Parse argv only: no shell expansion, process, transport or authority.
 * Keep this function self-contained: execution-bound CLI launchers serialize it.
 * onKey is an internal position observer used by the idempotency-key rewriter. */
export function parseThreadCommand(input, onKey) {
  if (!Array.isArray(input) || input.length > 64 || input.some((v) => typeof v !== "string" || v.length > 16384))
    throw Error("Invalid thread argv");
  const argv = [...input];
  let key;
  const args = {};
  if (argv[0] === "context") argv.unshift("thread");
  if (argv.shift() !== "thread") throw Error("Expected opencraft thread; use --help");
  const command = argv.shift();
  const positions = [];
  if (command === "operation" || command === "input") {
    const subcommand = argv.shift();
    if (subcommand !== (command === "operation" ? "show" : "status")) throw Error("Unknown subcommand");
  }
  const options = {
    "--profile": "profile",
    "--prompt": "prompt",
    "--title": "title",
    "--driver": "driver",
    "--cwd": "cwd",
    "--cursor": "cursor",
    "--limit": "limit",
    "--turns": "includeRecentTurns",
    "--message": "message",
    "--delivery": "delivery",
    "--expected-turn": "expectedTurnId",
    "--reply-expectation": "replyExpectation",
    "--timeout": "timeoutMs",
    "--wait-for": "waitFor",
  };
  const allowed = {
    context: [],
    output: ["cursor"],
    stop: ["expectedTurnId"],
    operation: [],
    input: [],
    list: ["cursor", "limit"],
    start: ["prompt", "title", "profile"],
    profiles: [],
    spawn: ["prompt", "title", "driver", "cwd"],
    show: ["includeRecentTurns"],
    tell: ["message", "delivery", "expectedTurnId", "replyExpectation"],
    wait: ["timeoutMs", "waitFor"],
  };
  if (!command || !Object.hasOwn(allowed, command)) throw Error("Unknown command; use --help");
  const seen = new Set();
  let children = false;
  while (argv.length) {
    const option = argv.shift();
    if (!option.startsWith("--")) {
      positions.push(option);
      continue;
    }
    if (seen.has(option)) throw Error("Duplicate option");
    seen.add(option);
    if (option === "--json") continue;
    if (option === "--owned" && command === "list") {
      args.owned = true;
      children = true;
      continue;
    }
    if (option === "--children" && command === "list") {
      children = true;
      continue;
    }
    const field = options[option];
    if (option !== "--idempotency-key" && (!field || !allowed[command].includes(field)))
      throw Error("Invalid option; use --help");
    const value = argv.shift();
    if (value === undefined) throw Error("Missing option value");
    if (option === "--idempotency-key") {
      onKey?.(input.length - argv.length - 1);
      key = value;
      continue;
    }
    args[field] = ["limit", "includeRecentTurns", "timeoutMs"].includes(field) ? Number(value) : value;
  }
  if (seen.has("--owned") && seen.has("--children")) throw Error("Choose --owned or --children");
  for (const field of ["limit", "includeRecentTurns", "timeoutMs"])
    if (args[field] !== undefined && (!Number.isSafeInteger(args[field]) || args[field] < 1))
      throw Error("Expected a positive integer");
  if (command === "list" && !children) throw Error("Use list --children or --owned");
  if (command === "operation" || command === "input") {
    if (positions.length !== 1) throw Error("One identifier required");
    args.id = positions[0];
  } else if (["show", "tell", "output", "stop"].includes(command)) {
    if (positions.length !== 1) throw Error("One conversation reference required");
    args.reference = positions[0];
  } else if (command === "wait") {
    if (!positions.length) throw Error("Conversation references required");
    args.references = positions;
  } else if (positions.length) throw Error("Unexpected positional argument");
  if (["start", "spawn", "tell", "stop"].includes(command) && !key)
    throw Error("An explicit --idempotency-key is required");
  return { command, arguments: args, ...(key ? { idempotencyKey: key } : {}) };
}

/** Change only the parsed option value, never a matching literal argument. */
export function replaceThreadCommandIdempotencyKey(input, key) {
  if (typeof key !== "string" || !key || key.length > 16384) throw Error("Invalid thread idempotency key");
  let index;
  parseThreadCommand(input, (valueIndex) => {
    index = valueIndex;
  });
  if (index === undefined) throw Error("Platform intent has no idempotency key");
  const argv = [...input];
  argv[index] = key;
  return argv;
}

/** Canonical delivery semantics shared by Bot and native-execution CLI adapters.
 * Legacy native is an alias for steer; unsupported interrupt never becomes queue. */
export function threadDeliveryIntent(delivery, expectedTurnId) {
  const mode = delivery === "native" ? "steer" : (delivery ?? "queue");
  if (mode === "interrupt") throw Error("unsupported_delivery");
  if (mode !== "queue" && mode !== "steer") throw Error("invalid_execution_mode");
  if (mode === "queue") {
    if (expectedTurnId !== undefined) throw Error("unexpected_turn");
    return { mode };
  }
  if (
    typeof expectedTurnId !== "string" ||
    !expectedTurnId.trim() ||
    expectedTurnId.length > 256 ||
    /[\x00-\x1f]/u.test(expectedTurnId)
  )
    throw Error("invalid_expected_turn");
  return { mode, expectedTurnId };
}
