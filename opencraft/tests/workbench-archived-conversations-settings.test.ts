import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const sidebarSource = readFileSync(
  new URL("../apps/workbench-web/src/components/sidebar.tsx", import.meta.url),
  "utf8",
);
const appSource = readFileSync(
  new URL("../apps/workbench-web/src/app.tsx", import.meta.url),
  "utf8",
);
const settingsSource = readFileSync(
  new URL("../apps/workbench-web/src/components/settings-page.tsx", import.meta.url),
  "utf8",
);
const threadManagementSource = readFileSync(
  new URL("../apps/workbench-web/src/components/thread-management.tsx", import.meta.url),
  "utf8",
);

test("archive management and undo feedback stay out of the primary Sidebar", () => {
  assert.doesNotMatch(sidebarSource, /onManageArchived|archiveUndo|已归档会话/u);
  assert.doesNotMatch(appSource, /archivedHostId|lastArchived|ArchivedThreadsDialog/u);
});

test("archived conversations are a capability-gated Settings page", () => {
  assert.match(settingsSource, /showArchivedConversations/u);
  assert.match(settingsSource, /section === "archived-conversations"/u);
  assert.match(settingsSource, /<ArchivedThreadsSettings/u);
  assert.match(threadManagementSource, /export function ArchivedThreadsSettings/u);
  assert.match(threadManagementSource, /No archived conversations\./u);
  assert.doesNotMatch(threadManagementSource, /ArchivedThreadsDialog/u);
  assert.match(appSource, /showArchivedConversations=\{archivedConversationsAvailable\}/u);
});
