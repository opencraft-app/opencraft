import React, { useLayoutEffect, useMemo, useState } from 'react';
import { createIntlTestRoot } from './intl-root';
import { Context } from '@deepseek-ai/cordis';
import { createConversationDisplayContinuity } from '@opencraft/workbench-runtime';
import { createConversationKey, type TimelineSnapshot } from '@opencraft/chat-core';
import { useConversationDisplay } from '../../apps/workbench-web/src/runtime/use-conversation-display';
import { TimelineBlockRendererProvider, TimelineBlockRendererRegistryService } from '@opencraft/timeline-render-react';
import { Conversation } from '../../apps/workbench-web/src/components/conversation';
import { BuiltinTimelineRendererPlugin } from '../../apps/workbench-web/src/components/conversation-renderers/builtin-timeline-renderer-plugin';
import '../../apps/workbench-web/src/styles/app.scss';
const ctx = new Context();
await ctx.plugin(TimelineBlockRendererRegistryService);
await ctx.plugin(BuiltinTimelineRendererPlugin);
const values = new Map<string, string>();
values.set('opencraft.display.v1.account-a.' + JSON.stringify(['host', 'a']), JSON.stringify({ version: 1, hostId: 'host', threadId: 'a', savedAt: Date.now(), messages: [
        { id: 'question', turnId: 'turn', role: 'user', text: 'My previously viewed question' },
        { id: 'answer', turnId: 'turn', role: 'assistant', text: 'My previously viewed answer' },
    ] }));
const storage = { load: async (key: string) => values.get(key) ?? null, save: async (key: string, value: string) => { values.set(key, value); }, remove: async (key: string) => { values.delete(key); } };
let owner = createConversationDisplayContinuity({ namespace: 'account-a', storage });
await owner.load('host', 'a');
const commits: any[] = [];
(window as any).displayBenchmark = { commits };
function App() {
    const [thread, setThread] = useState<string | null>(null), [scope, setScope] = useState('account-a');
    const [live, setLive] = useState<TimelineSnapshot | null>(null);
    const continuity = useMemo(() => ({ ...owner, getScope: () => scope, subscribe: () => () => {} }), [scope]);
    const key = useMemo(() => thread === null ? null : createConversationKey('host', thread), [thread]);
    const { selection } = useConversationDisplay(continuity, key, live);
    const visible = selection.timeline;
    (window as any).displayBenchmark.emptyThenDisconnect = (empty: boolean) => setLive(empty ? {
        key: createConversationKey('host', 'a'), revision: 2, phase: 'live', authoritative: true,
        frames: [], anchorFrameIds: new Map(),
    } : null);
    (window as any).displayBenchmark.returnToAccountA = () => {
        owner = createConversationDisplayContinuity({ namespace: 'account-a', storage });
        setScope('account-a');
    };
    useLayoutEffect(() => { commits.push({ thread, scope, frames: visible?.frames.length ?? 0, authoritative: visible?.authoritative ?? false }); }, [thread, scope, visible]);
    return <div style={{ height: '100vh', width: '100vw' }}><button onClick={() => setThread('a')}>Open A</button><button onClick={() => setThread(null)}>Close</button><button onClick={() => { owner = createConversationDisplayContinuity({ namespace: 'account-b', storage }); setScope('account-b'); }}>Switch account</button>
    <TimelineBlockRendererProvider registry={ctx.timelineBlockRenderers}><Conversation timeline={visible} threadDetailLevel="STEPS_PROSE" scrollPolicy="response-placement" footer={<><textarea aria-label="Draft" defaultValue="My unsent words"/><button disabled>Send</button></>}/></TimelineBlockRendererProvider></div>;
}
createIntlTestRoot(document.getElementById('root')).render(<App />);
