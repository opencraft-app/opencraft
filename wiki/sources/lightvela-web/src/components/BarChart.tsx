import { color, numeric } from '../theme';
import type { Attributes, RichNode } from '../types';

function label(value: number, expression?: string) {
  if (expression?.includes('%')) return `${value.toFixed(1)}%`;
  const unit = expression?.includes('人') ? ' 人' : expression?.includes('条') ? ' 条' : '';
  return `${value.toLocaleString('zh-CN')}${unit}`;
}

export default function BarChart({ attrs, data }: { attrs: Attributes; data: RichNode }) {
  const categories = (data.attrs.categories ?? '').split(',');
  const datasets = (data.children?.filter((n) => n.tag === 'series') ?? []).map((series) => {
    const values = (series.attrs.values ?? '').split(',').map(Number);
    const percentages = series.attrs.percentages?.split(',');
    return {
      name: series.attrs.name ?? '', values,
      fill: color(series.attrs.color ?? data.attrs.color ?? 'primary'),
      valueLabel: (i: number) => `${label(values[i], series.attrs['label-expr'])}${percentages?.[i] ? ` · ${percentages[i]}%` : ''}`,
    };
  });
  const width = numeric(attrs.width);
  const height = numeric(attrs.height);
  const max = numeric(attrs['y-max'], Math.max(...datasets.flatMap((s) => s.values), 1));
  const left = numeric(attrs['label-width'], Math.min(145, width * 0.28));
  const top = 18;
  const bottom = 34;
  const plotWidth = width - left - numeric(attrs['value-width'], 90);
  const rowHeight = (height - top - bottom) / categories.length;
  const fontSize = numeric(attrs['text-size'], 15);
  const valueSize = numeric(attrs['value-size'], fontSize);
  const tickCount = Math.max(2, numeric(attrs['tick-count'], 5));

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img"
      aria-label={categories.map((name, i) => `${name} ${datasets.map((s) => `${datasets.length > 1 ? `${s.name} ` : ''}${s.valueLabel(i)}`).join('，')}`).join('；')}>
      {Array.from({ length: tickCount }, (_, i) => {
        const x = left + plotWidth * i / (tickCount - 1);
        return <g key={i}>
          <line x1={x} y1={top} x2={x} y2={height - bottom} stroke={color('border')} />
          <text x={x} y={height - 8} textAnchor="middle" fill={color('text-muted')} fontSize={12}>{(max * i / (tickCount - 1)).toLocaleString('zh-CN')}{attrs['axis-suffix'] ?? ''}</text>
        </g>;
      })}
      {categories.map((category, i) => {
        const y = top + i * rowHeight;
        const gap = datasets.length > 1 ? 3 : 0;
        const barHeight = Math.min(36, rowHeight * (datasets.length > 1 ? 0.7 / datasets.length : 0.52));
        const groupHeight = barHeight * datasets.length + gap * (datasets.length - 1);
        return <g key={category}>
          <text x={left - 12} y={y + rowHeight / 2 + 5} textAnchor="end" fill={color('text-main')} fontSize={fontSize}>{category}</text>
          {datasets.map((s, j) => {
            const barWidth = plotWidth * s.values[i] / max;
            const barY = y + (rowHeight - groupHeight) / 2 + j * (barHeight + gap);
            const labelX = attrs['value-position'] === 'fixed' ? left + plotWidth + 12 : left + barWidth + 8;
            return <g key={j} data-series={s.name}>
              <rect x={left} y={barY} width={barWidth} height={barHeight} fill={s.fill} rx={2} />
              <text x={labelX} y={barY + barHeight / 2 + (datasets.length > 1 ? valueSize * 0.34 : 5)} fill={datasets.length > 1 ? s.fill : color('text-main')} fontSize={valueSize}>{s.valueLabel(i)}</text>
            </g>;
          })}
        </g>;
      })}
    </svg>
  );
}
