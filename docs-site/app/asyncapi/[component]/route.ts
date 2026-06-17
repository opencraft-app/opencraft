import fs from 'node:fs/promises';
import path from 'node:path';

export const revalidate = false;

async function readSpec(component: string) {
  const asyncapiDir = path.join(process.cwd(), 'asyncapi');
  for (const extension of ['json', 'yaml', 'yml']) {
    const file = path.join(asyncapiDir, `${component}.${extension}`);
    try {
      const body = await fs.readFile(file, 'utf8');
      return { body, extension };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  return undefined;
}

export async function GET(_request: Request, context: { params: Promise<{ component: string }> }) {
  const { component } = await context.params;
  if (!/^[a-z0-9-]+$/.test(component)) {
    return Response.json({ error: `invalid component id: ${component}` }, { status: 400 });
  }

  const spec = await readSpec(component);
  if (!spec) {
    return Response.json({ error: `asyncapi component not found: ${component}` }, { status: 404 });
  }

  if (spec.extension === 'json') {
    return Response.json(JSON.parse(spec.body));
  }

  return new Response(spec.body, {
    headers: {
      'content-type': 'application/yaml; charset=utf-8',
    },
  });
}
