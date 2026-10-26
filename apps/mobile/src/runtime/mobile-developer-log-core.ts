// Diagnostics only accept fixed events and nonnegative integer measurements.
export const MAX_DEVELOPER_LOG_LINES = 100;

export type DeveloperEvent =
  | "site.external.open.failed"
  | "speech.capture.started" | "speech.capture.failed" | "speech.capture.cleanup.failed"
  | "chat.panel.action.failed"
  | "account.profile.cache.hit" | "account.profile.display-cache.hit"
  | "account.profile.refresh.succeeded" | "account.profile.refresh.failed"
  | "avatar.picker.opened" | "avatar.picker.cancelled" | "avatar.picker.selected"
  | "avatar.prepare.failed" | "avatar.prepared" | "avatar.auth.missing"
  | "avatar.upload.started" | "avatar.upload.failed" | "avatar.upload.response"
  | "avatar.response.invalid" | "avatar.upload.succeeded"
  | "site.load.started" | "site.load.finished" | "site.load.failed"
  | "site.http.failed" | "site.dom.empty" | "site.dom.ready" | "site.script.failed"
  | "site.tab.selected" | "site.session.unavailable"
  | "bot.runtime.asset.loaded" | "bot.runtime.asset.failed" | "bot.runtime.origin.matched" | "bot.runtime.origin.missing"
  | "bot.runtime.load.failed" | "bot.runtime.http.failed" | "bot.catalog.updated"
  | "bot.runtime.timeout" | "bot.catalog.timeout" | "bot.runtime.script.failed"
  | "bot.section.render.failed" | "bot.runtime.process.terminated" | "bot.runtime.navigation.blocked"
  | "bot.api.network.failed" | "bot.api.http.failed"
  | "bot.model.load.failed"
  | "bot.session.operation.failed"
  | "bot.auth.pending" | "bot.auth.ready" | "bot.auth.missing"
  | "chat.submit.failed" | "chat.attachment.failed" | "chat.picker.failed"
  | "chat.model.list.failed" | "chat.request.failed"
  | "chat.resource.read.failed" | "chat.resource.open.failed";
export type DeveloperFacts = Readonly<{ bytes?: number; status?: number; attempt?: number; visibleChars?: number; tab?: number; kind?: number; line?: number; column?: number; endpoint?: number }>;
export type DeveloperLine = Readonly<{ time: string; event: DeveloperEvent; facts?: DeveloperFacts }>;

export function appendDeveloperLine(
  lines: readonly DeveloperLine[], time: string, event: DeveloperEvent, facts?: DeveloperFacts,
): readonly DeveloperLine[] {
  const safeFacts = facts && Object.fromEntries(
    Object.entries(facts).filter(([key, value]) =>
      (key === "bytes" || key === "status" || key === "attempt" || key === "visibleChars" || key === "tab" || key === "kind" || key === "line" || key === "column" || key === "endpoint") &&
      typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ),
  );
  return [...lines, { time, event, ...(safeFacts && Object.keys(safeFacts).length ? { facts: safeFacts } : {}) }]
    .slice(-MAX_DEVELOPER_LOG_LINES);
}
