import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { loadCodexActivityFunctions } from "../scripts/lib/codex-activity-reference";
import {
  partitionAgentActivityContentUnits,
  resolveAgentActivityLayout,
  type AgentActivityRenderUnit,
  type AgentActivityContentUnit,
} from "@opencraft/chat-core";

const source = loadCodexActivityFunctions();
const jsx = (type: unknown, props: any) => ({ type, props });
const original = vm.runInNewContext(
  `
  const kA={c:n=>Array(n).fill(Symbol.for('react.memo_cache_sentinel'))};
  const AA={useState:()=>[undefined,()=>{}]},jA={jsx,jsxs:jsx,Fragment:'fragment'};
  const Ss=()=>false,Fm=items=>items,yn=()=>null,qk='content',xA='header',Gl={div:'motion'},vl='presence';
  const Q=()=>false;
  ${source.activity}
  ${source.demotion}
  ${source.readiness}
  ({layout:DA,demote:je,final:isFinalAnswerPhase});
`,
  { jsx },
);

function unit(id: string, type: string): AgentActivityContentUnit {
  if (type === "worked-for")
    return {
      type,
      id,
      item: { type, status: "working", startedAtMs: 0, completedAtMs: null },
    };
  return {
    type: "standalone",
    id,
    block: {
      type,
      id,
      steeringStatus: type === "user-message" ? "accepted" : null,
    } as any,
  };
}
function native(units: readonly AgentActivityContentUnit[]) {
  return units.map((u) => ({
    kind: "standalone",
    key: u.id,
    item: {
      item:
        u.type === "worked-for"
          ? u.item
          : {
              ...(u as any).block,
              type:
                (u as any).block.type === "compaction"
                  ? "context-compaction"
                  : (u as any).block.type,
            },
    },
  }));
}

test("DA ownership regions match the original in one pass, including no-toggle partitions", () => {
  let cases = 0;
  for (const kinds of [
    ["worked-for"],
    ["worked-for", "compaction", "user-message"],
    ["worked-for", "text", "user-message"],
    ["realtime-transcript", "worked-for", "text", "realtime-transcript"],
  ])
    for (const hasFinalAssistantStarted of [false, true])
      for (const forceExpanded of [false, true])
        for (const disableCollapse of [false, true])
          for (const preventAutoCollapse of [false, true])
            for (const persistedCollapsed of [undefined, false, true]) {
              const contentUnits = kinds.map((kind, i) =>
                unit(String(i), kind),
              );
              const model = {
                contentUnits,
                partitions: partitionAgentActivityContentUnits(contentUnits),
                hasFinalAssistantStarted,
                hasRenderableAgentItems: true,
                forceExpanded,
                disableCollapse,
                preventAutoCollapse,
                isTurnCancelled: false,
                inlineSubagentActivity: null,
              } as AgentActivityRenderUnit;
              const expected = original.layout({
                items: native(contentUnits),
                agentActivityProps: {},
                hasFinalAssistantStarted,
                forceExpanded,
                disableCollapse,
                preventAutoCollapse,
                persistedCollapsed,
              });
              const [before, , header, , persistent, presence] =
                expected.props.children;
              const body = presence.props.children;
              const content = body?.props.children[1]?.props.children[0];
              const ids = (node: any): string[] =>
                Array.from(node?.props.units ?? [], (u: any) => u.key);
              const actual = resolveAgentActivityLayout(
                model,
                persistedCollapsed,
              );
              assert.deepEqual(
                {
                  showToggle: actual.showToggle,
                  collapsed: actual.isCollapsed,
                  before: actual.preToggleUnits.map((u) => u.id),
                  persistent: actual.persistentUnits.map((u) => u.id),
                  body: actual.isCollapsed
                    ? []
                    : actual.visibleUnits.map((u) => u.id),
                },
                {
                  showToggle: header !== null,
                  collapsed: header?.props.isCollapsed ?? false,
                  before: ids(before),
                  persistent: ids(persistent),
                  body: ids(content),
                },
                JSON.stringify({
                  kinds,
                  hasFinalAssistantStarted,
                  forceExpanded,
                  disableCollapse,
                  preventAutoCollapse,
                  persistedCollapsed,
                }),
              );
              cases++;
            }
  assert.equal(cases, 192);
});

test("original demotion retains the Unit key; an unphased displayable answer is not a final boundary", () => {
  const item = { item: { type: "exec" } };
  const demoted = original.demote(
    { kind: "group", key: "stable-unit", items: [item] },
    { kind: "summary" },
  );
  assert.equal(demoted.key, "stable-unit");
  assert.equal(demoted.kind, "standalone");
  assert.equal(
    original.final({
      content: "visible answer",
      completed: false,
      phase: null,
    }),
    false,
  );
  assert.equal(
    original.final({
      content: "visible answer",
      completed: false,
      phase: "final_answer",
    }),
    true,
  );
});
