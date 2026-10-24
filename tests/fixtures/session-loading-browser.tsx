import React, { useState, useSyncExternalStore } from 'react';
import { createIntlTestRoot } from './intl-root';
import { Context } from '@deepseek-ai/cordis';
import { WebSocketTransport } from '@opencraft/appserver-transport-websocket';
import { createAppServerWorkbenchRuntime } from '@opencraft/workbench-runtime';
import { TimelineBlockRendererProvider, TimelineBlockRendererRegistryService } from '@opencraft/timeline-render-react';
import { Conversation } from '../../apps/workbench-web/src/components/conversation';
import { BuiltinTimelineRendererPlugin } from '../../apps/workbench-web/src/components/conversation-renderers/builtin-timeline-renderer-plugin';
import '../../apps/workbench-web/src/styles/app.scss';
const ctx = new Context();
await ctx.plugin(TimelineBlockRendererRegistryService);
await ctx.plugin(BuiltinTimelineRendererPlugin);
const runtime = createAppServerWorkbenchRuntime({ hostId: 'benchmark', hostKind: 'durable', autoReconnect: false, requestTimeoutMs: 60000,
    createTransport: () => new WebSocketTransport({ url: location.origin.replace(/^http/, 'ws') + '/benchmark-rpc' }) });
await runtime.connect();
const metrics: any = {};
(window as any).loadingBenchmark = { metrics, runtime };
let epoch = 0;
function Thread({ lease }: any) {
    const state = useSyncExternalStore(lease.subscribe, lease.getSnapshot, lease.getSnapshot);
    React.useLayoutEffect(() => { if (state.timeline?.frames.length && metrics.paintedMs == null) {
        const current = epoch;
        requestAnimationFrame(() => { if (current !== epoch || metrics.paintedMs != null) return; metrics.paintedMs = performance.now() - metrics.start; metrics.frameCount = state.timeline.frames.length; });
    } }, [state.timeline]);
    return <div data-authoritative={String(state.authoritative)}><TimelineBlockRendererProvider registry={ctx.timelineBlockRenderers}><Conversation timeline={state.timeline} threadDetailLevel="STEPS_PROSE" scrollPolicy="response-placement" footer={<textarea aria-label="Draft" defaultValue="Preserve my draft"/>}/></TimelineBlockRendererProvider></div>;
}
function App() {
    const [lease, setLease] = useState<any>(null);
    const unsubscribe = React.useRef<(() => void) | null>(null);
    return <div style={{ width: '100vw', height: '100vh' }}><button onClick={async () => {
            const current = ++epoch;
            metrics.start = performance.now();
            metrics.paintedMs = null;
            metrics.readyMs = null;
            const next = await runtime.acquireThread(new URL(location.href).searchParams.get('thread')!);
            if (current !== epoch) { next.release(); return; }
            setLease(next);
            const check = () => { if (current === epoch && next.getSnapshot().authoritative && metrics.readyMs == null)
                metrics.readyMs = performance.now() - metrics.start; };
            unsubscribe.current?.();
            unsubscribe.current = next.subscribe(check);
            check();
        }}>Open conversation</button><button onClick={() => { epoch++; unsubscribe.current?.(); unsubscribe.current = null; lease?.release(); setLease(null); }}>Close conversation</button>{lease && <Thread lease={lease}/>}</div>;
}
createIntlTestRoot(document.getElementById('root')).render(<App />);
