import { color, numeric } from '../theme';
import type { Attributes, RichNode } from '../types';

function label(value: number, expression?: string) {
  if (expression?.includes('%')) return `${value.toFixed(1)}%`;
  const unit = expression?.includes('人') ? ' 人' : expression?.includes('条') ? ' 条' : '';
  return `${value.toLocaleString('zh-CN')}${unit}`;
}

export default function BarChart({ attrs, data }: { attrs: Attributes; data: RichNode }) {
  const categories = (data.attrs.categories ?? '').split(',');
  const series = data.children?.find((n) => n.tag === 'series');
  const values = (series?.attrs.values ?? '').split(',').map(Number);
  const percentages = series?.attrs.percentages?.split(',');
  const valueLabel = (i: number) => `${label(values[i], series?.attrs['label-expr'])}${percentages?.[i] ? ` · ${percentages[i]}%` : ''}`;
  const width = numeric(attrs.width);
  const height = numeric(attrs.height);
  const max = numeric(attrs['y-max'], Math.max(...values, 1));
  const left = numeric(attrs['label-width'], Math.min(145, width * 0.28));
  const top = 18;
  const bottom = 34;
  const plotWidth = width - left - numeric(attrs['value-width'], 90);
  const rowHeight = (height - top - bottom) / categories.length;
  const fill = color(series?.attrs.color ?? data.attrs.color ?? 'primary');
  const fontSize = numeric(attrs['text-size'], 15);
  const valueSize = numeric(attrs['value-size'], fontSize);

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img"
      aria-label={categories.map((name, i) => `${name} ${valueLabel(i)}`).join('；')}>
      {Array.from({ length: 5 }, (_, i) => {
        const x = left + plotWidth * i / 4;
        return <g key={i}>
          <line x1={x} y1={top} x2={x} y2={height - bottom} stroke={color('border')} />
          <text x={x} y={height - 8} textAnchor="middle" fill={color('text-muted')} fontSize={12}>{(max * i / 4).toLocaleString('zh-CN')}</text>
        </g>;
      })}
      {categories.map((category, i) => {
        const y = top + i * rowHeight;
        const barHeight = Math.min(36, rowHeight * 0.52);
        const barWidth = plotWidth * values[i] / max;
        return <g key={category}>
          <text x={left - 12} y={y + rowHeight / 2 + 5} textAnchor="end" fill={color('text-main')} fontSize={fontSize}>{category}</text>
          <rect x={left} y={y + (rowHeight - barHeight) / 2} width={barWidth} height={barHeight} fill={fill} rx={2} />
          <text x={left + barWidth + 8} y={y + rowHeight / 2 + 5} fill={color('text-main')} fontSize={valueSize}>{valueLabel(i)}</text>
        </g>;
      })}
    </svg>
  );
}
