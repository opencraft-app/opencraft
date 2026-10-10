import { useEffect, useMemo, useRef, useState } from 'react';
import template from '../data/infra-template.html?raw';
import type { DynamicContent } from '../types';

export type InfraAction =
  | { action: 'navigate'; delta: -1 | 1 }
  | { action: 'edge'; edge: 'first' | 'last' }
  | { action: 'key'; key: string };

export function makeInfraDocument(config: {
  pageIndex: number; number: number; total: number; token: string;
  parentOrigin: string; static: boolean; manual: boolean;
}) {
  // 配置不可逃出script块；template只来自归档的用户演示素材。
  return template.replace('__LV_EMBED_CONFIG__', JSON.stringify(config).replace(/</g, '\\u003c'));
}

export default function DynamicSlide({ data, number, total, staticPreview, paused, onAction }: {
  data: DynamicContent; number: number; total: number;
  staticPreview: boolean; paused: boolean; onAction?: (event: InfraAction) => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [token] = useState(() => crypto.randomUUID());
  const [manual] = useState(() => {
    try { return sessionStorage.getItem('lightvela-infra-mode') === 'manual'; } catch { return false; }
  });
  const [loaded, setLoaded] = useState(false);
  const document = useMemo(() => makeInfraDocument({ pageIndex: data.pageIndex, number, total, token, parentOrigin: window.location.origin, static: staticPreview, manual }), [data.pageIndex, number, total, token, staticPreview, manual]);

  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || event.origin !== 'null' || !event.data || event.data.type !== 'lightvela-infra' || event.data.token !== token || staticPreview) return;
      const message = event.data;
      if (message.action === 'ready' && message.pageIndex === data.pageIndex) setLoaded(true);
      if (message.action === 'mode' && typeof message.manual === 'boolean') {
        try { sessionStorage.setItem('lightvela-infra-mode', message.manual ? 'manual' : 'auto'); } catch { /* 私密模式仍可使用当前页 */ }
      }
      if (message.action === 'navigate' && [1, -1].includes(message.delta)) onAction?.({ action: 'navigate', delta: message.delta });
      if (message.action === 'edge' && ['first', 'last'].includes(message.edge)) onAction?.({ action: 'edge', edge: message.edge });
      if (message.action === 'key' && ['f', 'c', 'g', '?', 'Escape'].includes(message.key)) onAction?.({ action: 'key', key: message.key });
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [token, staticPreview, data.pageIndex, onAction]);

  useEffect(() => {
    if (!loaded || staticPreview) return;
    frame.current?.contentWindow?.postMessage({ type: 'lightvela-infra-control', token, action: paused ? 'pause' : 'resume' }, '*');
  }, [paused, loaded, staticPreview, token]);

  useEffect(() => {
    if (staticPreview || paused) return;
    const key = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey || (event.target instanceof Element && event.target.closest('input,textarea,select,[contenteditable="true"]'))) return;
      const action = { r: 'replay', m: 'mode', n: 'advance' }[event.key.toLowerCase()];
      if (!action) return;
      event.preventDefault();
      frame.current?.contentWindow?.postMessage({ type: 'lightvela-infra-control', token, action }, '*');
    };
    window.addEventListener('keydown', key);
    const source = frame.current?.contentWindow;
    return () => {
      window.removeEventListener('keydown', key);
      source?.postMessage({ type: 'lightvela-infra-control', token, action: 'pause' }, '*');
    };
  }, [token, paused, staticPreview]);

  return <iframe ref={frame} className="infra-frame" title={`基础设施动画：${data.title}`} sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={document} tabIndex={staticPreview ? -1 : 0} style={{ width: '100%', height: '100%', border: 0, display: 'block', pointerEvents: staticPreview ? 'none' : 'auto' }} />;
}
