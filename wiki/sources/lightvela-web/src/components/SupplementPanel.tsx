import { content, supplements } from '../deck';
import type { ImageContent } from '../types';
import useCanvasScale from '../useCanvasScale';
import SlideCanvas from './SlideCanvas';

const hints: Record<string, string> = {
  '出圈回顾': '保留原始背景、时间线与截图。点击图片查看完整原图，关闭后回到正文。',
  '个人助理产品洞察': '保留原文市场全表、场景数据、链接和能力分数，仅用于参考。关闭后回到正文。',
  '产品现状': '保留原独立站全流程、配置能力、实验室、友商比较及10月9日历史规模口径。历史生效套餐与最新累计注册、Pass领取数据分开统计。点击截图查看完整原图，关闭后回到正文。',
  '产品演进': '保留原架构、完整场景（含多云）、身份探索、开放接口与体验截图；均按原文口径作参考。点击图片查看完整原图，关闭后回到正文。',
};

export default function SupplementPanel({ selected, onSelect, onImage }: {
  selected: string; onSelect: (id: string) => void; onImage: (image: ImageContent) => void;
}) {
  const { ref, scale } = useCanvasScale();
  const page = supplements.find((item) => item.id === selected) ?? supplements[0];
  const references = supplements.filter((item) => item.group === page.group);
  return (
    <section className="supplement-panel" aria-label={`${page.group}补充材料`}>
      <div className="supplement-heading"><span className="supplement-kicker">{page.group} · {page.group === '出圈回顾' ? '补充材料' : '详细参考'}</span><h2>{page.label}</h2></div>
      <nav className="supplement-tabs" aria-label="选择补充材料">
        {references.map((item) => <button key={item.id} className={`text-button ${item.id === page.id ? 'selected' : ''}`} aria-pressed={item.id === page.id} onClick={() => onSelect(item.id)}>{item.label}</button>)}
      </nav>
      <div className="supplement-stage" ref={ref}><SlideCanvas page={page} content={content} scale={scale} onImage={onImage} /></div>
      <p className="supplement-hint">{hints[page.group] ?? '完整资料仅作参考，关闭后回到正文。'}</p>
    </section>
  );
}
