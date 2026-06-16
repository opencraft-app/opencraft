import { getLLMText } from '@/lib/get-llm-text';
import { listGeneratedLLMComponents, readGeneratedLLMText } from '@/lib/generated-llms';
import { source } from '@/lib/source';

export const revalidate = false;

export async function GET() {
  const pages = await Promise.all(source.getPages().map(getLLMText));
  const componentTexts = await Promise.all((await listGeneratedLLMComponents()).map(readGeneratedLLMText));

  return new Response([...pages, ...componentTexts.filter((text): text is string => Boolean(text))].join('\n\n---\n\n'), {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
    },
  });
}
