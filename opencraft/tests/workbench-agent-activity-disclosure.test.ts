import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  reduceAgentActivityDisclosurePhase,
  type AgentActivityDisclosurePhase,
} from "../apps/workbench-web/src/components/agent-activity-group-disclosure";

test("r2440 Agent Activity disclosure uses four interruptible phases", () => {
  assert.equal(reduceAgentActivityDisclosurePhase("collapsed", "toggle"), "opening");
  assert.equal(reduceAgentActivityDisclosurePhase("opening", "animation-frame"), "expanded");
  assert.equal(reduceAgentActivityDisclosurePhase("expanded", "toggle"), "closing");
  assert.equal(reduceAgentActivityDisclosurePhase("closing", "animation-complete"), "collapsed");
});

test("r2440 Agent Activity disclosure reverses an interrupted close without remounting", () => {
  let phase: AgentActivityDisclosurePhase = "expanded";
  phase = reduceAgentActivityDisclosurePhase(phase, "toggle");
  assert.equal(phase, "closing");
  phase = reduceAgentActivityDisclosurePhase(phase, "toggle");
  assert.equal(phase, "expanded");
  assert.equal(reduceAgentActivityDisclosurePhase(phase, "disable"), "collapsed");
});

test("r2440 virtualization belongs to the sole top-level Turn slot, never an inner Activity row", () => {
  const conversationSource = readFileSync(new URL("../apps/workbench-web/src/components/conversation.tsx", import.meta.url), "utf8");
  const styles = readFileSync(new URL("../apps/workbench-web/src/styles/app.scss", import.meta.url), "utf8");
  assert.match(conversationSource, /className="thread-frame__slot"/u);
  assert.doesNotMatch(conversationSource, /data-virtualized-unit/u);
  assert.match(styles, /\.thread-frame__slot\[data-virtualized-turn-content\]/u);
  assert.doesNotMatch(styles, /\.thread-agent-activity__unit\[data-virtualized-unit/u);
});

test("terminal Turn errors use Codex's neutral timeline banner instead of an error-owned card", () => {
  const conversationSource = readFileSync(new URL("../apps/workbench-web/src/components/conversation.tsx", import.meta.url), "utf8");
  const styles = readFileSync(new URL("../apps/workbench-web/src/styles/app.scss", import.meta.url), "utf8");
  const errorStyleStart = styles.indexOf(".thread-system-error {");
  const errorStyleEnd = styles.indexOf("\n.thread-turn-render-error", errorStyleStart);
  const errorStyles = styles.slice(errorStyleStart, errorStyleEnd);
  assert.match(conversationSource, /className="thread-system-error"/u);
  assert.doesNotMatch(conversationSource, /className="thread-error-card"/u);
  assert.ok(errorStyleStart >= 0 && errorStyleEnd > errorStyleStart);
  assert.match(errorStyles, /border:\s*1px solid var\(--color-border-subtle\)/u);
  assert.doesNotMatch(errorStyles, /color-decoration-deleted/u);
});
