import assert from "node:assert/strict";
import test from "node:test";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ComposerQueueTray } from "../packages/codex-composer/src/queue-tray";

const pendingItem = {
  id: "client-command-1",
  preview: "Inspect the failed deployment",
  state: "submitting" as const,
  operation: "idle" as const,
  actionable: false,
  editing: false,
};

test("normal queued follow-ups render as messages rather than transport UI", () => {
  const markup = renderToStaticMarkup(
    <ComposerQueueTray
      items={[pendingItem]}
      pausedReason={null}
      isResponseInProgress
    />,
  );

  assert.match(markup, /Inspect the failed deployment/);
  assert.match(markup, /data-queue-size="1"/);
  assert.doesNotMatch(markup, /codex-composer-queue-tray__heading/);
  assert.doesNotMatch(markup, />(?:Adding…|Saving…|Queued)</);
  assert.match(markup, /aria-busy="true"/);
});

test("queue interruption is the only state promoted to a tray header", () => {
  const markup = renderToStaticMarkup(
    <ComposerQueueTray
      items={[{ ...pendingItem, state: "failed" }]}
      pausedReason="interrupted"
      isResponseInProgress={false}
    />,
  );

  assert.match(markup, /Queue paused because you interrupted/);
  assert.match(markup, /Resume/);
});
