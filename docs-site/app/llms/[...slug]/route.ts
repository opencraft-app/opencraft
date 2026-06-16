import { readGeneratedLLMText } from '@/lib/generated-llms';

export const revalidate = false;

export async function GET(_request: Request, context: { params: Promise<{ slug: string[] }> }) {
  const { slug } = await context.params;
  if (slug.length !== 1 || !slug[0].endsWith('.txt')) {
    return Response.json({ error: 'not found' }, { status: 404 });
  }

  const component = slug[0].slice(0, -4);
  const text = await readGeneratedLLMText(component);
  if (!text) {
    return Response.json({ error: `llms component not found: ${component}` }, { status: 404 });
  }

  return new Response(text, {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
    },
  });
}
