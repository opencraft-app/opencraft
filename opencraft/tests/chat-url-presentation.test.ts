import assert from "node:assert/strict";
import test from "node:test";
import {
  externalLinkMenuIntent,
  externalLinkPointerIntent,
  faviconSources,
  SAFE_URL_SETTLE_MS,
} from "../packages/chat-render-web/src/renderers/resource-link/external-link-model.js";

test("Codex URL presentation uses origin and Google favicon fallbacks", () => {
  assert.deepEqual(faviconSources("https://git.example.test/merge/1"), [
    "https://git.example.test/favicon.ico",
    "https://www.google.com/s2/favicons?domain=https%3A%2F%2Fgit.example.test&sz=32",
  ]);
  assert.deepEqual(faviconSources("mailto:user@example.test"), []);
});

test("Codex URL opening intents preserve keyboard and alternate-tab semantics", () => {
  assert.equal(SAFE_URL_SETTLE_MS, 500);
  assert.deepEqual(externalLinkPointerIntent({ button: 0, ctrlKey: false, detail: 1, metaKey: false }), {
    source: "pointer", target: "default", disposition: "current-tab",
  });
  assert.deepEqual(externalLinkPointerIntent({ button: 0, ctrlKey: false, detail: 0, metaKey: false }), {
    source: "keyboard", target: "default", disposition: "current-tab",
  });
  assert.deepEqual(externalLinkPointerIntent({ button: 0, ctrlKey: false, detail: 1, metaKey: true }), {
    source: "pointer", target: "default", disposition: "new-tab",
  });
  assert.deepEqual(externalLinkPointerIntent({ button: 1, ctrlKey: false, detail: 1, metaKey: false }), {
    source: "pointer", target: "default", disposition: "new-tab",
  });
  assert.equal(externalLinkPointerIntent({ button: 2, ctrlKey: false, detail: 1, metaKey: false }), null);
  assert.deepEqual(externalLinkMenuIntent("external-browser"), {
    source: "context-menu", target: "external-browser", disposition: "current-tab",
  });
});
