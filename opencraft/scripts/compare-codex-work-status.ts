import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import vm from "node:vm";
import ts from "typescript";
import {
  deriveTurnWorkStatus,
  formatWorkDuration,
  formatCodexToolDuration,
  type TimelineSourceTurn,
} from "@opencraft/chat-core";

const root =
  process.env.CODEX_REFERENCE_ROOT ??
  "/data/mia/.runtime/lifecycle-authority-dead-contract-r3562";
const { insertWorkStatusItem } = await import(
  pathToFileURL(`${root}/editor/shared/derive-work-interval.js`).href
);
const durationPath = `${root}/lazy/app-initial/format-duration-pzs-606to.js`;
const durationSource = ts.createSourceFile(
  durationPath,
  readFileSync(durationPath, "utf8"),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.JS,
);
// Execute the actual pure original functions without bootstrapping its app imports.
const functions = durationSource.statements
  .filter(ts.isFunctionDeclaration)
  .filter((node) =>
    [
      "formatDuration__pzs_606to",
      "formatDurationShort",
      "formatNumberWithUnit",
    ].includes(node.name?.text ?? ""),
  )
  .map((node) => node.getText(durationSource).replace(/^export\s+/, ""))
  .join("\n");
const original = vm.runInNewContext(
  `${functions}\nconst mzs = new Map(); ({short: formatDurationShort, full: formatDuration__pzs_606to});`,
  { Intl, Map },
);
let intervals = 0;
const itemSets = [
  [],
  [{ type: "userMessage" }],
  [{ type: "reasoning" }],
  [{ type: "agentMessage", phase: "final_answer", text: "answer" }],
  ...["", " ", "answer"].flatMap((text) =>
    [false, true].map((completed) => [
      { type: "reasoning" },
      { type: "agentMessage", phase: "final_answer", text, completed },
    ]),
  ),
  [
    { type: "userMessage" },
    { type: "agentMessage", phase: "commentary", text: "Working" },
    { type: "agentMessage", phase: "final_answer", text: "answer" },
  ],
];
for (const status of [
  "streaming",
  "complete",
  "failed",
  "interrupted",
] as const) {
  for (const items of itemSets)
    for (const started of [null, 1_000])
      for (const finalStarted of [null, 3_000]) {
        const turn: TimelineSourceTurn = {
          id: "turn",
          status,
          startedAtMs: 500,
          firstTurnWorkItemStartedAtMs: started,
          finalAssistantStartedAtMs: finalStarted,
          items: items.map((payload, index) => ({
            id: String(index),
            type: payload.type,
            payload,
          })),
        };
        const expected =
          insertWorkStatusItem({
            status:
              status === "streaming"
                ? "in_progress"
                : status === "interrupted"
                  ? "cancelled"
                  : status,
            workStartedAtMs: started === null ? null : 500,
            finalAssistantStartedAtMs: finalStarted,
            items: items.map((item) => ({
              ...item,
              type:
                item.type === "agentMessage"
                  ? "assistant-message"
                  : item.type === "userMessage"
                    ? "user-message"
                    : item.type,
              content: "text" in item ? item.text : "",
            })),
          }).find((item: { type: string }) => item.type === "worked-for") ??
          null;
        assert.deepEqual(
          deriveTurnWorkStatus(turn),
          expected,
          JSON.stringify(turn),
        );
        intervals += 1;
      }
}
let durations = 0;
for (const locale of ["en", "zh-CN", "hu", "de", "fr"])
  for (const ms of [
    -100, 0, 900, 1_600, 59_999, 60_000, 61_999, 3_600_000, 3_601_000,
    86_400_000, 90_061_000,
  ]) {
    assert.equal(formatWorkDuration(ms, locale), original.short(ms, locale));
    assert.equal(
      formatCodexToolDuration(ms, locale),
      original.full(ms, { locale }),
    );
    durations += 2;
  }
console.log(
  JSON.stringify({ original: root, intervals, durations, differences: 0 }),
);
