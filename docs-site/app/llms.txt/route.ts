import { source } from '@/lib/source';
import { llms } from 'fumadocs-core/source';
import { listGeneratedLLMComponents } from '@/lib/generated-llms';

export const revalidate = false;

export async function GET() {
  const componentLines = (await listGeneratedLLMComponents()).map((component) => `- ${component}: /llms/${component}.txt`);
  const body = [llms(source).index(), '# Component LLM Fragments', '', ...componentLines].join('\n');

  return new Response(body, {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
    },
  });
}
