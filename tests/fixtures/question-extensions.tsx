import React, { useEffect, useRef, useState } from "react";
import { Context } from "@deepseek-ai/cordis";
import { createConversationKey, createDefaultTimelineProjectorRegistry, projectTimeline } from "@opencraft/chat-core";
import { TimelineBlockRendererProvider, TimelineBlockRendererRegistryService } from "@opencraft/timeline-render-react";
import { Conversation } from "../../apps/workbench-web/src/components/conversation";
import { BuiltinTimelineRendererPlugin } from "../../apps/workbench-web/src/components/conversation-renderers/builtin-timeline-renderer-plugin";
import { ConversationPendingInteractionPanel } from "../../apps/workbench-web/src/components/conversation-renderers/interaction/interaction-renderers";
import { InteractionDraftStore } from "../../apps/workbench-web/src/components/conversation-renderers/interaction/interaction-drafts";
import { createIntlTestRoot as createRoot } from "./intl-root";
import "../../apps/workbench-web/src/styles/app.scss";
import { initializeAppearanceTheme, setThemePreference } from "../../apps/workbench-web/src/appearance-theme";
const params = new URLSearchParams(location.search);
const entryMode = params.has("entry");
const theme = params.get("theme") === "dark" ? "dark" : "light";
initializeAppearanceTheme(); setThemePreference(new URLSearchParams(location.search).get("theme") === "dark" ? "dark" : theme);
const ctx = new Context();
await ctx.plugin(TimelineBlockRendererRegistryService);
await ctx.plugin(BuiltinTimelineRendererPlugin);
const registry = createDefaultTimelineProjectorRegistry();
(window as any).answers = [];
const block: any = { id: "question", type: "question", requestId: "request", method: "item/tool/requestUserInput", state: "pending", questions: [{ id: "q", header: "Plan review", prompt: "Choose steps", multiSelect: true, detail: "# Full fixture plan\n\nVerify the **complete** result before delivery.", intent: { kind: "plan-review", approve: "Verify" }, isOther: true, isSecret: false, options: [{ id: "a", label: "Verify", description: "Check behavior" }, { id: "b", label: "Deliver", description: "Finish delivery" }] }] };
function Demo() {
  const [generation, setGeneration] = useState(0);
  const [mounted, setMounted] = useState(true);
  const [revision, setRevision] = useState(0);
  const [current, setCurrent] = useState(block);
  const lastBlock = useRef(block);
  const [draftStore] = useState(() => new InteractionDraftStore());
  const setupSequence = useRef(0);
  const requestSequence = useRef(0);
  (window as any).entryFixture = {
    reset: (kind: string) => {
      setGeneration(value => value + 1); setRevision(value => value + 1);
      setCurrent(kind === "question" ? { ...block, requestId: `question-${requestSequence.current++}` } : {
        id: "approval", type: "approval", approvalKind: "command", requestId: `approval-${requestSequence.current++}`,
        method: "item/commandExecution/requestApproval", state: "pending", title: "Allow fixture command?",
        command: "printf fixture", cwd: "/fixture", availableDecisions: [], sourceItemIds: [],
      });
    },
    restore: () => { setMounted(false); setRevision(value => value + 1); },
    clear: () => { setCurrent(null); setRevision(value => value + 1); },
    appear: (kind: string) => {
      setCurrent(kind === "question" ? { ...block, requestId: `question-${requestSequence.current++}` } : {
        id: "approval", type: "approval", approvalKind: "command", requestId: `approval-${requestSequence.current++}`,
        method: "item/commandExecution/requestApproval", state: "pending", title: "Allow fixture command?",
        command: "printf fixture", cwd: "/fixture", availableDecisions: [], sourceItemIds: [],
      }); setRevision(value => value + 1);
    },
    refresh: () => { setCurrent((value: any) => structuredClone(value)); setRevision(value => value + 1); },
  };
  useEffect(() => { if (!mounted) { setGeneration(value => value + 1); setMounted(true); } }, [mounted]);
  (window as any).questionFixture = {
    showSetup: (kind: "role" | "task" | "context") => {
      const next = { id: `setup-${kind}`, type: kind === "context" ? "setup-context-picker" : "setup-step", step: kind,
        requestId: `setup-${kind}-${setupSequence.current++}`, sourceItemIds: [], method: "item/tool/call", state: "pending" };
      lastBlock.current = next; setCurrent(next); return next.requestId;
    },
    hide: () => { lastBlock.current = current; setCurrent(null); },
    replay: () => setCurrent(structuredClone(lastBlock.current)),
    changeSetupStep: (step: "role" | "task") => setCurrent((value: any) => ({ ...value, step })),
    showOptionPicker: () => setCurrent({ id: "picker", type: "option-picker", requestId: "picker-request", method: "item/tool/call", state: "pending", question: "Choose a scope", allowMultiple: false, options: [{ id: "small", label: "Small", description: null }, { id: "wide", label: "Wide", description: null }], submitLabel: null, skipLabel: null }),
    refresh: () => setCurrent((value: any) => structuredClone(value)),
    replaceRequest: () => setCurrent((value: any) => ({ ...value, requestId: `${value.requestId}-replacement` })),
    changeQuestion: () => setCurrent((value: any) => ({ ...value, questions: value.questions.map((question: any) => ({ ...question, prompt: "Choose updated steps" })) })),
    showTwoQuestions: () => setCurrent({ ...block, requestId: "two-question-request", questions: [block.questions[0], { ...block.questions[0], id: "second", header: "Second question", prompt: "Describe second step", multiSelect: false, options: [] }] }),
  };
  const panel = <ConversationPendingInteractionPanel block={current} draftStore={draftStore} draftScope="question-fixture" onRespondInteraction={async (_, action) => { (window as any).answers.push(action); }} />;
  const timeline = projectTimeline({ key: createConversationKey("fixture", "thread"), revision, authoritative: true, phase: "live",
    turns: [{ id: "turn", status: "streaming", items: [] }] }, registry);
  if (entryMode) return <div data-entry-revision={revision} style={{ width: "100vw", height: "100dvh" }}>
    <TimelineBlockRendererProvider registry={ctx.timelineBlockRenderers}>
      {mounted ? <Conversation key={generation} timeline={timeline} scrollPolicy="natural" footer={panel} /> : null}
    </TimelineBlockRendererProvider>
  </div>;
  return <main style={{ maxWidth: 600, margin: "20px auto" }}>{panel}</main>;
}
createRoot(document.getElementById("root")!).render(<Demo />);
