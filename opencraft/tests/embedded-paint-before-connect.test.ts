import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("the embedded Draft paints before the Host connects; sending stays gated", () => {
  const element = read("../apps/workbench-web/src/embedded-chat/embedded-workbench-element.tsx");
  const prepareOwned = element.slice(element.indexOf("private async prepareOwned"), element.indexOf("private handlePainted"));
  assert.ok(prepareOwned.length > 0, "prepareOwned should exist");
  // prepare()/show() resolve on paint; awaiting the connection here re-hides the Composer behind the host overlay.
  assert.doesNotMatch(prepareOwned, /await this\.connection\.ready/u);
  assert.ok(prepareOwned.indexOf("this.renderApplication()") < prepareOwned.indexOf("await this.paintedPromise"));
  const show = element.slice(element.indexOf("async show()"), element.indexOf("hide()"));
  assert.match(show, /await this\.paintedPromise/u);
  assert.doesNotMatch(show, /await this\.readyPromise/u);

  const draft = read("../apps/workbench-web/src/components/new-thread-draft-page.tsx");
  assert.match(draft, /submissionDisabled=\{connectionPhase !== "ready"\}/u);
});
