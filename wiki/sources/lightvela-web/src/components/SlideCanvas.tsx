import type { CSSProperties } from 'react';
import { color, numeric, textStyle, theme } from '../theme';
import type { ContentMap, RichNode, ImageContent, VideoContent, SlideElement, SlidePage } from '../types';
import { richText } from './RichText';
import BarChart from './BarChart';
import DataTable from './DataTable';
import DynamicSlide, { type InfraAction } from './DynamicSlide';

function Element({ element, content, onNavigate, onImage, onVideo }: {
  element: SlideElement; content: ContentMap;
  onNavigate?: (id: string) => void; onImage?: (image: ImageContent) => void;
  onVideo?: (video: VideoContent) => void;
}) {
  const a = element.attrs;
  const width = numeric(a.width), height = numeric(a.height);
  const base: CSSProperties = { position: 'absolute', left: numeric(a.x), top: numeric(a.y), width, height, opacity: numeric(a.opacity, 1) };
  const data = element.contentKey ? content[element.contentKey] : undefined;
  if (element.type === 'background') return null;
  if (element.type === 'shape') {
    if (a.type === 'line') return <svg className="shape-line" style={{ position: 'absolute', left: numeric(a.x) - 5, top: numeric(a.y) - 5, width: Math.abs(width) + 10, height: Math.abs(height) + 10 }} aria-hidden="true">
      <defs><marker id={`arrow-${element.key}`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill={color(a.stroke ?? 'text-main')} /></marker></defs>
      <line x1={5} y1={5} x2={width + 5} y2={height + 5} stroke={color(a.stroke ?? 'text-main')} strokeWidth={numeric(a['stroke-width'], 1)}
        strokeDasharray={a['stroke-dash'] === 'dash' ? '6 4' : undefined} markerEnd={a['arrow-end'] === 'arrow' ? `url(#arrow-${element.key})` : undefined} />
    </svg>;
    return <div aria-hidden="true" style={{ ...base, background: color(a.fill), borderRadius: a.type === 'ellipse' ? '50%' : numeric(a['corner-radius']), border: a.stroke ? `${numeric(a['stroke-width'], 1)}px solid ${color(a.stroke)}` : undefined }} />;
  }
  if (element.type === 'text' && data && 'tag' in data) return (
    <div data-element={element.key} className="slide-text" style={{ ...base, ...textStyle(a), lineHeight: numeric(a['line-height'], 1.2), whiteSpace: a.wrap === 'false' ? 'nowrap' : undefined,
      display: 'flex', flexDirection: 'column', justifyContent: a.anchor === 'middle' ? 'center' : a.anchor === 'bottom' ? 'flex-end' : 'flex-start', backgroundColor: color(a.fill) }}>
      {richText(data, onNavigate, element.key)}
    </div>
  );
  if (element.type === 'video' && data && 'poster' in data) {
    const preview = <><img src={data.poster} alt={data.title} draggable={false} /><span className="video-play-mark" aria-hidden="true"><svg viewBox="0 0 24 24" width="22" height="22"><path d="M8 5v14l12-7z" fill="currentColor" /></svg></span><span className="video-caption" aria-hidden="true">播放演示 · {data.duration.toFixed(1)} 秒</span></>;
    const style = { ...base, borderRadius: numeric(a['corner-radius']), border: `1px solid ${color(a.stroke ?? 'border')}` };
    return onVideo ? <button className="slide-video" style={style} aria-label={`播放${data.title}`} onClick={() => onVideo(data)}>{preview}</button> : <div className="slide-video" style={style}>{preview}</div>;
  }
  if (element.type === 'image' && data && 'alt' in data) {
    const image = <img src={data.src} alt={data.alt} loading="eager" draggable={false} style={{ width: '100%', height: '100%', objectFit: a.fit === 'contain' ? 'contain' : a.fit === 'stretch' ? 'fill' : 'cover' }} />;
    const style = { ...base, border: a.stroke ? `${numeric(a['stroke-width'], 1)}px solid ${color(a.stroke)}` : undefined, borderRadius: numeric(a['corner-radius']) };
    const isMascot = data.src.includes('_trim.png');
    return onImage && !isMascot ? <button className="slide-image" style={style} aria-label="放大原始截图" onClick={() => onImage({ ...data, src: data.originalSrc ?? data.src })}>{image}</button> : <div className="slide-image" style={style}>{image}</div>;
  }
  if (element.type === 'table' && data && 'tag' in data) return <div style={base}><DataTable attrs={a} data={data as RichNode} /></div>;
  if (element.type === 'chart' && data && 'tag' in data) return <div style={base}><BarChart attrs={a} data={data} /></div>;
  return null;
}

export default function SlideCanvas({ page, content, scale = 1, onNavigate, onImage, onVideo, total = 1, paused = false, onInfraAction }: {
  page: SlidePage; content: ContentMap; scale?: number;
  onNavigate?: (id: string) => void; onImage?: (image: ImageContent) => void;
  onVideo?: (video: VideoContent) => void;
  total?: number; paused?: boolean; onInfraAction?: (event: InfraAction) => void;
}) {
  return <div className="slide-sizer" style={{ width: theme.size.width * scale, height: theme.size.height * scale }}>
    <article className="slide-canvas" aria-label={`第 ${page.number} 页：${page.title}`} data-slide-id={page.id}
      style={{ width: theme.size.width, height: theme.size.height, transform: `scale(${scale})`, background: color('bg-page') }}>
      {page.elements.map((element) => {
        const data = element.contentKey && content[element.contentKey];
        if (element.type === 'dynamic' && data && 'pageIndex' in data) return <DynamicSlide key={`${page.id}-${element.key}`} data={data} number={page.number} total={total} staticPreview={!onInfraAction} paused={paused} onAction={onInfraAction} />;
        return <Element key={element.key} element={element} content={content} onNavigate={onNavigate} onImage={onImage} onVideo={onVideo} />;
      })}
    </article>
  </div>;
}
