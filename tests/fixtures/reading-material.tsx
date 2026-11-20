import React from 'react';
import { createConversationKey, createDefaultTimelineProjectorRegistry, projectTimeline } from '@opencraft/chat-core';
import { createComposerController } from '@opencraft/composer-core';
import { TimelineBlockRendererProvider } from '@opencraft/timeline-render-react';
import { ComposerTurnChangeSummary } from '../../apps/workbench-web/src/components/conversation/turn-diff-resource';
import { Conversation } from '../../apps/workbench-web/src/components/conversation';
import { OpenCraftComposer } from '@opencraft/composer-editor';
import { installSideChatPreviewFixture } from './side-chat-preview';
import { buildOpenCraftThemeCssProperties, seeThemePalette, opencraftNeutralThemePalette } from '@opencraft/design-system/theme-engine';

export async function installReadingMaterialFixture(ctx: any) {
  const side = await installSideChatPreviewFixture(ctx);
  const key = createConversationKey('fixture', 'main-material');
  const composer = createComposerController({ type: 'existing-thread', key }, { now: Date.now, createId: () => crypto.randomUUID() });
  const timeline = projectTimeline({ key, revision: 1, authoritative: true, phase: 'live', turns: Array.from({ length: 12 }, (_, i) => ({
    id: `main-${i}`, status: 'completed' as const, items: [
      { id: `question-${i}`, type: 'userMessage' as const, payload: { content: [{ type: 'inputText', text: `Review the shared reading surface ${i}` }] } },
      { id: `answer-${i}`, type: 'agentMessage' as const, payload: { text: `**Material and layout ${i}**\n\nThe main and side conversation share a viewport and composer. Reading, selection and the draft remain stable while changing themes.\n\n` + 'A continuous canvas remains visible around the dock. '.repeat(8), phase: 'final_answer', completed: true } },
    ],
  })) }, createDefaultTimelineProjectorRegistry());
  Object.assign(window, { readingMaterial: { theme(mode: 'light' | 'dark', neutral = false) {
    document.documentElement.dataset.theme = mode;
    for (const [key, value] of Object.entries(buildOpenCraftThemeCssProperties(mode, (neutral ? opencraftNeutralThemePalette : seeThemePalette)[mode]))) document.documentElement.style.setProperty(key, value);
  }, composer } });
  const changesTimeline = projectTimeline({ key, revision: 1, authoritative: true, phase: 'live', turns: [{
    id: 'live-changes', status: 'streaming', items: [{ id: 'working', type: 'agentMessage', payload: { text: 'Updating files', phase: 'commentary', completed: false } }],
    unifiedDiff: Array.from({length: 5}, (_, i) => `diff --git a/file${i}.ts b/file${i}.ts\n--- a/file${i}.ts\n+++ b/file${i}.ts\n@@ -1 +1,2 @@\n-old\n+new\n+line\n`).join(''),
  }] }, createDefaultTimelineProjectorRegistry());
  function Main() {
    const [changes, setChanges] = React.useState(false);
    const [queue, setQueue] = React.useState(false);
    (window as any).readingMaterial.changes = setChanges;
    (window as any).readingMaterial.queue = setQueue;
    return <TimelineBlockRendererProvider registry={ctx.timelineBlockRenderers}><Conversation timeline={timeline} scrollPolicy="response-placement" footer={<div className="thread-composer-region"><OpenCraftComposer controller={composer}
      floatingContent={changes ? <ComposerTurnChangeSummary timeline={changesTimeline} turnId="live-changes" documentContext={{ onReviewTurnDiff: () => {} }} /> : null}
      queuedSubmissions={queue ? [{ id: "reading-queue", preview: "A queued follow-up shares the editor material", state: "queued", operation: "idle", actionable: true,
        editableContent: { document: composer.getSnapshot().draft.document, attachments: [], context: [] } }] : []}
      onSubmit={() => false} onCancel={() => {}} /></div>} /></TimelineBlockRendererProvider>;
  }
  return { Main, side };
}
