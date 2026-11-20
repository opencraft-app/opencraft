import { botBinding } from "../../domain/bot-binding.mjs";
import { stable } from "../../domain/values.mjs";
import { MemorySynthesisPolicy } from "../../domain/memory-synthesis.mjs";
import { CalendarSchedule } from "../../domain/calendar-schedule.mjs";
import { RunPolicy } from "../../domain/run-policy.mjs";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  chmodSync,
  realpathSync,
  statSync,
  lstatSync,
} from "node:fs";
import { resolve, join, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { resolveHarnesses } from "../codex/config.mjs";

function resolveConcurrency(value = 8) {
  if (!Number.isInteger(value) || value < 1 || value > 8)
    throw new Error("concurrency must be 1..8");
  return value;
}

export function initProfile(directory, owner, options = {}) {
  if (!owner || typeof owner !== "string")
    throw new Error("An explicit local owner label is required");
  const concurrency = resolveConcurrency(options.concurrency);
  const path = resolve(directory);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const config = {
    schema: 1,
    assistantId: randomUUID(),
    owner,
    mode: "fixture",
    memoryDefaultScope: "agent",
    fixtureDelayMs: 100,
    ...options,
    concurrency,
  };
  config.runPolicy = RunPolicy.resolve(config.runPolicy);
  validateTelemetry(config.telemetry);
  resolveHarnesses(config);
  config.memoryPolicy = MemorySynthesisPolicy.resolve(config.memoryPolicy);
  config.memoryDefaultScope ??= "user";
  if (!["agent", "user"].includes(config.memoryDefaultScope))
    throw new Error("memoryDefaultScope must be agent or user");
  if (config.memoryRoot !== undefined) {
    if (typeof config.memoryRoot !== "string" || !isAbsolute(config.memoryRoot))
      throw new Error("memoryRoot must be an explicit absolute path");
  }
  config.timeZone ??= "UTC";
  CalendarSchedule.normalize({
    kind: "calendar",
    timeZone: config.timeZone,
    hours: [9],
    minutes: [0],
  });
  if (config.workspace !== undefined) {
    config.workspace = realpathSync(resolve(config.workspace));
    if (!statSync(config.workspace).isDirectory())
      throw new Error("workspace must be an explicit existing directory");
  }
  writeFileSync(
    join(path, "profile.json"),
    JSON.stringify(config, null, 2) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  return loadProfile(path);
}

export function loadProfile(directory) {
  const path = realpathSync(resolve(directory));
  if (lstatSync(join(path, "profile.json")).isSymbolicLink())
    throw Error("Profile cannot be a symlink");
  const config = JSON.parse(readFileSync(join(path, "profile.json"), "utf8"));
  if (config.layout !== undefined && config.layout !== "bot-v1")
    throw Error("Unsupported profile layout");
  if (config.layout === "bot-v1") {
    const binding = botBinding(config.botBinding);
    if (
      config.assistantId !== binding.botId ||
      config.owner !== stable([binding.owner.kind, binding.owner.id]) ||
      config.memoryRoot !== undefined ||
      config.memoryDefaultScope !== "agent"
    )
      throw Error("Bot profile binding or memory scope differs");
  } else if (config.botBinding !== undefined)
    throw Error("Bot binding requires bot-v1 layout");
  if (config.schema !== 1 || !config.assistantId || !config.owner)
    throw new Error("Unsupported or incomplete profile");
  resolveHarnesses(config);
  validateTelemetry(config.telemetry);
  if (!["fixture", "model"].includes(config.mode))
    throw new Error("mode must be fixture or model");
  config.concurrency = resolveConcurrency(config.concurrency);
  if (
    !Number.isInteger(config.fixtureDelayMs) ||
    config.fixtureDelayMs < 0 ||
    config.fixtureDelayMs > 60000
  )
    throw new Error("fixtureDelayMs must be 0..60000");
  config.runPolicy = RunPolicy.resolve(config.runPolicy);
  config.memoryPolicy = MemorySynthesisPolicy.resolve(config.memoryPolicy);
  config.memoryDefaultScope ??= "user";
  if (!["agent", "user"].includes(config.memoryDefaultScope))
    throw new Error("memoryDefaultScope must be agent or user");
  if (config.memoryRoot !== undefined) {
    if (typeof config.memoryRoot !== "string" || !isAbsolute(config.memoryRoot))
      throw new Error("memoryRoot must be an explicit absolute path");
  }
  config.timeZone ??= "UTC";
  CalendarSchedule.normalize({
    kind: "calendar",
    timeZone: config.timeZone,
    hours: [9],
    minutes: [0],
  });
  if (config.workspace !== undefined) {
    if (!isAbsolute(config.workspace))
      throw new Error(
        "Persisted workspace must be absolute; init resolves relative bindings",
      );
    config.workspace = realpathSync(resolve(config.workspace));
    if (!statSync(config.workspace).isDirectory())
      throw new Error("workspace must be an explicit existing directory");
  }
  chmodSync(path, 0o700);
  for (const name of [
    "executions",
    "artifacts",
    "mailbox",
    ...(config.layout === "bot-v1"
      ? [
          "engines",
          "engines/codex",
          "engines/pi",
          "memory",
          "tmp",
          "outgoing",
          "attachments",
          "telemetry",
        ]
      : []),
  ]) {
    const directory = join(path, name);
    try {
      mkdirSync(directory, { mode: 0o700 });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const stat = lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw Error("Profile directory cannot be a symlink or file");
  }
  if (config.layout === "bot-v1") {
    for (const name of [
      "assistant.sqlite",
      "assistant.sqlite-wal",
      "assistant.sqlite-shm",
    ]) {
      try {
        if (lstatSync(join(path, name)).isSymbolicLink())
          throw Error("Bot database cannot be a symlink");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  }
  return { path, config, socket: join(path, "runner.sock") };
}

function validateTelemetry(value) {
  if (value === undefined) return;
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((k) => k !== "enabled") ||
    typeof value.enabled !== "boolean"
  )
    throw new Error("telemetry accepts only an explicit enabled boolean");
}

// Test-only crash windows are explicitly selected by the test process, never by model input.
export function fault(profile, point) {
  if (process.env.LAB_TEST_CRASH_AT !== point) return;
  const marker = join(profile.path, `.fault-${point}`);
  if (existsSync(marker)) return;
  writeFileSync(marker, point, { flag: "wx", mode: 0o600 });
  process.exit(86);
}
