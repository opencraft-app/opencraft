import { File, Paths } from "expo-file-system";
import * as SecureStore from "expo-secure-store";
import { appendDeveloperLine, MAX_DEVELOPER_LOG_LINES, type DeveloperEvent, type DeveloperFacts, type DeveloperLine } from "./mobile-developer-log-core";

const MODE_KEY = "opencraft.developer-mode-v1";
const logFile = new File(Paths.document, "opencraft-developer-log-v1.json");

// Never pass URLs, tokens, user IDs, file paths, response bodies, or
// exception messages to the log; appendDeveloperLine drops unknown fields.

let lines: readonly DeveloperLine[] | null = null;
const listeners = new Set<() => void>();

function readLines(): readonly DeveloperLine[] {
  if (lines) return lines;
  try {
    if (logFile.exists) {
      const parsed: unknown = JSON.parse(logFile.textSync());
      if (Array.isArray(parsed)) {
        lines = parsed.filter((line): line is DeveloperLine =>
          !!line && typeof line === "object" && typeof line.time === "string" && typeof line.event === "string"
        ).slice(-MAX_DEVELOPER_LOG_LINES);
        return lines;
      }
    }
  } catch { /* A damaged local log must not affect account actions. */ }
  lines = [];
  return lines;
}

function publish(next: readonly DeveloperLine[]) {
  lines = next;
  try { logFile.write(JSON.stringify(next)); } catch { /* Diagnostics never block user actions. */ }
  for (const listener of listeners) listener();
}

export const mobileDeveloperLog = {
  getSnapshot: readLines,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
  log(event: DeveloperEvent, facts?: DeveloperFacts) {
    publish(appendDeveloperLine(readLines(), new Date().toISOString(), event, facts));
  },
  clear() { publish([]); },
};

let enabled = false;
let initialized: Promise<void> | null = null;
const modeListeners = new Set<() => void>();

export const mobileDeveloperMode = {
  getSnapshot: () => enabled,
  subscribe(listener: () => void) {
    modeListeners.add(listener);
    return () => { modeListeners.delete(listener); };
  },
  initialize() {
    if (!initialized) initialized = SecureStore.getItemAsync(MODE_KEY)
      .then(value => { enabled = value === "true"; for (const listener of modeListeners) listener(); })
      .catch(() => undefined);
    return initialized;
  },
  async setEnabled(value: boolean) {
    await SecureStore.setItemAsync(MODE_KEY, String(value));
    enabled = value;
    for (const listener of modeListeners) listener();
  },
};
