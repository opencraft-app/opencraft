import './conversation-scroll';
import { flushSync } from 'react-dom';
import { setTimelineDiagnosticObserver } from '@opencraft/timeline-host-web';

const probe = window as any;
probe.momentumDiagnostics = [];
setTimelineDiagnosticObserver((kind, fields) => probe.momentumDiagnostics.push({ at: performance.now(), kind, fields }));
probe.commitMomentumChange = (index: number, height: number) => flushSync(() => probe.change(index, height));
probe.commitMomentumMeasurements = () => flushSync(() => probe.flushTurnMeasurements());
