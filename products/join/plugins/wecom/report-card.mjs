/** A small assistant-facing format; only documented, passive card fields reach WeCom. */
const text = (value, max, required = false) => {
  if (value === undefined && !required) return '';
  if (typeof value !== 'string' || !value.trim() || value.length > max || !value.isWellFormed()) throw Error('Invalid report text');
  return value.trim();
};
const url = value => {
  const result = new URL(text(value, 2048, true));
  if (!['https:', 'http:'].includes(result.protocol) || result.username || result.password) throw Error('Invalid report URL');
  return result.href;
};
export function reportCard(report) {
  if (!report || typeof report !== 'object' || Array.isArray(report)
    || Object.keys(report).some(k => !['title','summary','url','imageUrl','metrics'].includes(k))) throw Error('Invalid report');
  const title = text(report.title, 36, true), summary = text(report.summary, 112), details = url(report.url);
  const metrics = report.metrics ?? [];
  if (!Array.isArray(metrics) || metrics.length > 6) throw Error('Invalid report metrics');
  const card = {
    card_type: report.imageUrl ? 'news_notice' : 'text_notice',
    source: { desc: 'OpenCraft' }, main_title: { title, ...(summary ? { desc: summary } : {}) },
    horizontal_content_list: metrics.map(m => ({ keyname: text(m.label, 5, true), value: text(m.value, 26, true) })),
    jump_list: [{ type: 1, title: '查看详情', url: details }], card_action: { type: 1, url: details },
  };
  if (report.imageUrl) card.card_image = { url: url(report.imageUrl), aspect_ratio: 2.25 };
  return card;
}
export function parseReport(text) {
  const match = /^\s*\/图文\s+(\{[\s\S]*\})\s*$/u.exec(text);
  if (!match) return null;
  const report = JSON.parse(match[1]); reportCard(report); return report;
}
export function reportSummary(report) {
  return [report.title, report.summary, ...(report.metrics ?? []).map(m => `${m.label}：${m.value}`), '查看详情：' + report.url].filter(Boolean).join('\n');
}
