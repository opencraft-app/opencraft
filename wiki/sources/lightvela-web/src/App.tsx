import { useCallback, useEffect, useRef, useState } from 'react';
import { clampPage, content, pageFromHash, pages, supplementEntry, supplementFromHash, supplements } from './deck';
import type { ImageContent, VideoContent } from './types';
import SlideCanvas from './components/SlideCanvas';
import Sidebar from './components/Sidebar';
import SupplementPanel from './components/SupplementPanel';
import VideoPlayer from './components/VideoPlayer';
import useCanvasScale from './useCanvasScale';
import type { InfraAction } from './components/DynamicSlide';

export default function App() {
  const [index, setIndex] = useState(() => pageFromHash(window.location.hash));
  const [supplement, setSupplement] = useState<string | null>(() => supplementFromHash(window.location.hash));
  const [sidebar, setSidebar] = useState(() => window.innerWidth >= 900);
  const [overview, setOverview] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [image, setImage] = useState<ImageContent | null>(null);
  const [video, setVideo] = useState<VideoContent | null>(null);
  const [help, setHelp] = useState(false);
  const [notice, setNotice] = useState('');
  const app = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const { ref: stage, scale } = useCanvasScale();
  const page = pages[index];
  const referenceEntry = supplementEntry(page.id);
  const selectedReference = supplements.find((item) => item.id === supplement);
  const referenceLabel = selectedReference ? `${selectedReference.group}补充材料` : '补充材料';

  const navigate = useCallback((next: number) => {
    const safe = clampPage(next);
    setIndex(safe);
    setOverview(false);
    setSupplement(null);
    setImage(null);
    setVideo(null);
    setHelp(false);
    window.history.replaceState(null, '', `#/${pages[safe].id}`);
    if (window.innerWidth < 900) setSidebar(false);
  }, []);
  const navigateId = useCallback((id: string) => {
    const next = pages.findIndex((p) => p.id === id);
    if (next >= 0) navigate(next);
  }, [navigate]);
  const openSupplement = useCallback((id: string) => {
    setSupplement(id);
    setImage(null);
    setVideo(null);
    setHelp(false);
    setOverview(false);
    window.history.replaceState(null, '', `#/supplements/${id}`);
  }, []);
  const closeModal = useCallback(() => {
    if (image && supplement) { setImage(null); return; }
    setImage(null);
    setVideo(null);
    setHelp(false);
    setSupplement(null);
    if (supplement) window.history.replaceState(null, '', `#/${pages[index].id}`);
  }, [image, supplement, index]);

  const toggleFullscreen = useCallback(async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (app.current?.requestFullscreen) await app.current.requestFullscreen();
      else setNotice('当前浏览器不支持全屏，可使用浏览器自带的全屏功能。');
    } catch {
      setNotice('浏览器未允许全屏，请在独立窗口打开预览后重试。');
    }
  }, []);

  const onInfraAction = useCallback((event: InfraAction) => {
    if (image || video || help || supplement || overview) return;
    if (event.action === 'navigate') navigate(index + event.delta);
    if (event.action === 'edge') navigate(event.edge === 'first' ? 0 : pages.length - 1);
    if (event.action === 'key') {
      if (event.key === 'f') void toggleFullscreen();
      if (event.key === 'c') setSidebar((value) => !value);
      if (event.key === 'g') setOverview(true);
      if (event.key === '?') setHelp(true);
      if (event.key === 'Escape') closeModal();
    }
  }, [index, navigate, toggleFullscreen, closeModal, image, video, help, supplement, overview]);

  useEffect(() => {
    const changed = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', changed);
    return () => document.removeEventListener('fullscreenchange', changed);
  }, []);
  useEffect(() => {
    const changed = () => {
      setIndex(pageFromHash(window.location.hash));
      setSupplement(supplementFromHash(window.location.hash));
      setImage(null);
      setVideo(null);
      setHelp(false);
      setOverview(false);
    };
    window.addEventListener('hashchange', changed);
    return () => window.removeEventListener('hashchange', changed);
  }, []);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      const target = event.target;
      if ((target instanceof Element && target.closest('input, textarea, select, [contenteditable="true"]')) || event.ctrlKey || event.altKey || event.metaKey) return;
      if (event.key === 'Escape') { event.preventDefault(); closeModal(); setOverview(false); return; }
      if (image || video || help || supplement) return;
      if (['ArrowRight', 'ArrowDown', 'PageDown', ' '].includes(event.key)) { event.preventDefault(); navigate(index + 1); }
      if (['ArrowLeft', 'ArrowUp', 'PageUp'].includes(event.key)) { event.preventDefault(); navigate(index - 1); }
      if (event.key === 'Home') { event.preventDefault(); navigate(0); }
      if (event.key === 'End') { event.preventDefault(); navigate(pages.length - 1); }
      if (event.key.toLowerCase() === 'f') { event.preventDefault(); void toggleFullscreen(); }
      if (event.key.toLowerCase() === 'c') setSidebar((value) => !value);
      if (event.key.toLowerCase() === 'g') setOverview((value) => !value);
      if (event.key === '?') setHelp(true);
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [index, navigate, image, video, help, supplement, closeModal, toggleFullscreen]);
  useEffect(() => {
    if (image || video || help || supplement) { if (!dialog.current?.open) dialog.current?.showModal(); }
    else dialog.current?.close();
  }, [image, video, help, supplement]);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(''), 5000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  return (
    <div ref={app} className={`app ${fullscreen ? 'is-fullscreen' : ''}`}>
      <header className="app-header">
        <div className="brand-lockup"><img className="brand-logo" src="/assets/lightvela-logo.png" alt="LightVela Logo" width="32" height="32" /><span className="wordmark">LightVela</span><span className="header-divider" /><span className="workspace-name">产品与增长汇报</span></div>
        <div className="header-meta"><span className="private-pill"><span className="status-dot" />内部演示</span><span className="date-label">2026.10</span></div>
      </header>
      <div className="app-body">
        {sidebar && !fullscreen && <Sidebar current={index} onNavigate={navigate} onClose={() => setSidebar(false)} />}
        <main className="workspace">
          <div className="workspace-toolbar">
            <div className="toolbar-left"><button className="icon-button" aria-label={sidebar ? '收起目录' : '展开目录'} onClick={() => setSidebar(!sidebar)} title="目录 C"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></svg></button><span className="breadcrumb">{page.section.split(' · ')[0]}</span></div>
            <div className="toolbar-actions">
              <button className={`text-button ${overview ? 'selected' : ''}`} onClick={() => setOverview(!overview)} aria-pressed={overview}>总览</button>
              <button className="text-button" onClick={() => navigate(1)}>目录页</button>
              {referenceEntry && <button className="text-button supplement-trigger" onClick={() => openSupplement(referenceEntry.id)}>{referenceEntry.group === '出圈回顾' ? '补充材料' : '详细参考'}</button>}
              <button className="text-button help-trigger" onClick={() => setHelp(true)} aria-label="快捷键帮助">快捷键</button>
              <button className="present-button" onClick={() => void toggleFullscreen()}>{fullscreen ? '退出全屏' : '全屏演示'}<span aria-hidden="true">↗</span></button>
              {import.meta.env.VITE_REPORT_PROTECTED === 'true' && <form method="post" action="/__auth/logout"><button className="text-button" type="submit">退出登录</button></form>}
            </div>
          </div>
          <div className="stage" ref={stage}>
            {overview ? <div className="overview" aria-label="页面总览">{pages.map((p) => <button key={p.id} className={`overview-item ${p.id === page.id ? 'active' : ''}`} onClick={() => navigate(p.number - 1)}>
              <div className="mini-slide"><SlideCanvas page={p} content={content} scale={0.22} total={pages.length} /></div><span><b>{String(p.number).padStart(2, '0')}</b>{p.title}</span>
            </button>)}</div> : <SlideCanvas page={page} content={content} scale={scale} total={pages.length} paused={Boolean(image || video || help || supplement)} onInfraAction={onInfraAction} onNavigate={navigateId} onImage={setImage} onVideo={setVideo} />}
          </div>
          <footer className="player-footer">
            <span className="slide-caption">{page.title}</span>
            <div className="player-navigation"><button className="icon-button nav-button" aria-label="上一页" disabled={index === 0} onClick={() => navigate(index - 1)}>‹</button><span className="page-indicator" aria-live="polite"><strong>{String(index + 1).padStart(2, '0')}</strong><span>/ {pages.length}</span></span><button className="icon-button nav-button" aria-label="下一页" disabled={index === pages.length - 1} onClick={() => navigate(index + 1)}>›</button></div>
            <span className="scale-indicator">{Math.round(scale * 100)}% · 16:9</span>
          </footer>
          <div className="reading-progress"><span style={{ width: `${(index + 1) / pages.length * 100}%` }} /></div>
        </main>
      </div>
      <dialog ref={dialog} className={`modal ${image ? 'image-modal' : video ? 'video-modal' : supplement ? 'supplement-modal' : ''}`} aria-label={image ? '原始截图查看器' : video ? '新视觉演示视频' : supplement ? referenceLabel : '快捷键帮助'} onCancel={(event) => { event.preventDefault(); closeModal(); }} onClick={(event) => { if (event.target === event.currentTarget) closeModal(); }}>
        <button className="dialog-close icon-button" aria-label="关闭弹窗" onClick={closeModal}>×</button>
        {image ? <><img src={image.src} alt={image.alt} /><p>原始截图 · 可滚动查看 · 按 Esc 关闭</p></> : video ? <VideoPlayer video={video} /> : supplement ? <SupplementPanel selected={supplement} onSelect={openSupplement} onImage={setImage} /> : <><h2>演示快捷键</h2><div className="shortcut-list"><span>下一页</span><kbd>→ / 空格 / PgDn</kbd><span>上一页</span><kbd>← / PgUp</kbd><span>首页 / 封底</span><kbd>Home / End</kbd><span>全屏演示</span><kbd>F</kbd><span>收起 / 展开目录</span><kbd>C</kbd><span>页面总览</span><kbd>G</kbd><span>退出弹窗</span><kbd>Esc</kbd><span>动画重播 / 切换模式 / 下一段</span><kbd>R / M / N</kbd></div><p>基础设施第21–28页保留原动画，自动或手动播放；手动模式点击画面或“下一段”推进，方案页可点幕标签。方向键始终翻整页，F使用文稿全屏。点击正文截图查看完整原图；新视觉页可手动播放官网演示视频。各章节可查看对应原材料。</p></>}
      </dialog>
      {notice && <div className="toast" role="status">{notice}</div>}
    </div>
  );
}
