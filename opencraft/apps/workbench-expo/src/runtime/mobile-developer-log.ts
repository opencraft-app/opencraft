import type { DeveloperEvent, DeveloperFacts } from "./mobile-developer-log-core";

// The iOS implementation persists the bounded log. Other renderers retain the
// same call site without recording account or conversation data.
export const mobileDeveloperLog = {
  log(_event: DeveloperEvent, _facts?: DeveloperFacts): void {},
};
