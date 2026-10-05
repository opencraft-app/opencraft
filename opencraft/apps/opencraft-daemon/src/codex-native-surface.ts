import {
  OPENCRAFT_METHOD_ACCESS_EXTENSION,
  OPENCRAFT_THREAD_LIFECYCLE_EXTENSION,
  OPENCRAFT_THREAD_START_DURABILITY_EXTENSION,
  OPENCRAFT_FIRST_TURN_DURABILITY_CAPABILITY,
  OPENCRAFT_THREAD_QUEUE_EXTENSION,
  OPENCRAFT_THREAD_GOAL_EXTENSION,
  OPENCRAFT_ATTACHMENT_STAGING_EXTENSION,
  OPENCRAFT_PERMISSION_MODES_EXTENSION,
} from "@opencraft/appserver-protocol";
import { OPENCRAFT_DESKTOP_EXTENSION } from "@opencraft/appserver-protocol/desktop";

// Native operations with Server/Thread/file identities. The shared broker can
// route these independently of stdio/SSH. Connection-local handles (PTY, watch,
// search) need identity translation; local OpenCraft stores are not native RPCs.
export const CODEX_NATIVE_SHARED_METHODS = Object.freeze([
  "model/list", "config/read", "configRequirements/read", "permissionProfile/list",
  "config/batchWrite", "skills/list",
  "thread/list", "thread/read", "thread/turns/list", "thread/items/list", "thread/loaded/list",
  "thread/start", "thread/resume", "thread/fork", "thread/unsubscribe",
  "thread/name/set", "thread/archive", "thread/unarchive", "thread/compact/start",
  "turn/start", "turn/steer", "turn/interrupt",
  "fs/readDirectory", "fs/getMetadata", "fs/readFile", "fs/writeFile", "fs/createDirectory",
] as const);

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

/** Preserve upstream metadata, but never advertise stores owned by this machine. */
export function projectSharedNativeCodexInitialize(value: unknown): Record<string, unknown> {
  const result = record(value);
  const capabilities = record(result.capabilities);
  const extensions = { ...record(capabilities.extensions) };
  for (const extension of [OPENCRAFT_THREAD_QUEUE_EXTENSION, OPENCRAFT_THREAD_GOAL_EXTENSION,
    OPENCRAFT_ATTACHMENT_STAGING_EXTENSION, OPENCRAFT_PERMISSION_MODES_EXTENSION, OPENCRAFT_DESKTOP_EXTENSION,
    "opencraft/host-capabilities", "opencraft/loopback-http", "opencraft/browser"]) delete extensions[extension];
  // Only these lifecycle operations are routed by this shared-native surface.
  extensions[OPENCRAFT_THREAD_LIFECYCLE_EXTENSION] = {
    version: 1, fork: true, rename: true, archive: true, unsubscribe: true,
    ephemeral: false, injectItems: false, delete: false,
  };
  extensions[OPENCRAFT_METHOD_ACCESS_EXTENSION] = { version: 1, methods: CODEX_NATIVE_SHARED_METHODS };
  extensions[OPENCRAFT_THREAD_START_DURABILITY_EXTENSION] = OPENCRAFT_FIRST_TURN_DURABILITY_CAPABILITY;
  return { ...result, capabilities: { ...capabilities, extensions } };
}
