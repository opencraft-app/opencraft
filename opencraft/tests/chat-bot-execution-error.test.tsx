import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { BotExecutionError, botExecutionErrorCopy } from "../plugins/bot-chat/src/execution-error";

test("Bot execution errors use stable user copy rather than provider diagnostics", () => {
  assert.match(botExecutionErrorCopy("BOT_PROVIDER_QUOTA_LIMIT"), /quota/u);
  assert.match(botExecutionErrorCopy("BOT_MODEL_NOT_CONFIGURED"), /not configured/u);
  assert.match(botExecutionErrorCopy("BOT_PROVIDER_AUTH_REQUIRED"), /credentials/u);
  assert.match(botExecutionErrorCopy("BOT_RESPONSE_TIMEOUT"), /too long/u);
  assert.equal(botExecutionErrorCopy("PRIVATE_UPSTREAM_ERROR_WITH_TOKEN"), "This Bot could not complete its reply.");
  assert.equal(botExecutionErrorCopy(undefined), "This Bot could not complete its reply.");
});

test("a failed group member gets an accessible, named inline error", () => {
  const html = renderToStaticMarkup(createElement(BotExecutionError, {
    code: "BOT_PROVIDER_QUOTA_LIMIT",
    participantName: "999",
  }));
  assert.match(html, /role="status"/u);
  assert.match(html, /999 couldn&#x27;t reply/u);
  assert.match(html, /Model provider quota or balance is exhausted/u);
  assert.doesNotMatch(html, /PRIVATE_UPSTREAM_ERROR_WITH_TOKEN/u);
});
