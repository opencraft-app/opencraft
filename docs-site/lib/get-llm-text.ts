import type { source } from '@/lib/source';

export async function getLLMText(page: (typeof source)['$inferPage']) {
  const processed = await page.data.getText('processed');
  const summary = page.data.description ? `\n\n${page.data.description}` : '';

  return `# ${page.data.title} (${page.url})${summary}\n\n${processed}`;
}
