import { color, numeric, textStyle } from '../theme';
import { richText } from './RichText';
import type { Attributes, RichNode } from '../types';

export default function DataTable({ attrs, data }: { attrs: Attributes; data: RichNode }) {
  const rows = data.children?.filter((node) => node.tag === 'tr') ?? [];
  const weights = (attrs.columns ?? '').split(',').map(Number);
  const total = weights.reduce((sum, value) => sum + value, 0);
  const rowHeights = (attrs.rows ?? '').split(',').map(Number);
  return (
    <table className="data-table" style={{ ...textStyle(attrs), width: '100%', height: '100%', lineHeight: numeric(attrs['line-height'], 1.35) }}>
      <colgroup>{weights.map((weight, i) => <col key={i} style={{ width: `${weight / total * 100}%` }} />)}</colgroup>
      <tbody>{rows.map((row, r) => (
        <tr key={r} style={{ ...textStyle(row.attrs), height: rowHeights[r], backgroundColor: color(row.attrs.fill ?? (r === 0 ? attrs['header-fill'] : attrs.fill)) }}>
          {row.children?.filter((cell) => cell.tag === 'td').map((cell, c) => (
            <td key={c} colSpan={numeric(cell.attrs.colspan, 1)} rowSpan={numeric(cell.attrs.rowspan, 1)}
              style={{ ...textStyle(cell.attrs), padding: (cell.attrs.padding ?? attrs.padding ?? '8 10').split(' ').map((n) => `${n}px`).join(' '),
                backgroundColor: color(cell.attrs.fill), borderBottom: r === 0 ? `2px solid ${color('primary')}` : `1px solid ${color('border')}` }}>
              {richText(cell, undefined, `r${r}c${c}`)}
            </td>
          ))}
        </tr>
      ))}</tbody>
    </table>
  );
}
