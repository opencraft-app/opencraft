import fs from 'node:fs/promises';
import path from 'node:path';

import { languageFromRequest } from '@/lib/language';
import { localizeOpenAPI } from '@/lib/openapi-localize';

export const revalidate = false;

function isComponentID(value: string) {
  return /^[a-z0-9-]+$/.test(value);
}

async function readSpec(component: string) {
  const openapiDir = path.join(process.cwd(), 'openapi');
  for (const extension of ['json', 'yaml', 'yml']) {
    const file = path.join(openapiDir, `${component}.${extension}`);
    try {
      const body = await fs.readFile(file, 'utf8');
      return { body, extension };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  return undefined;
}

export async function GET(request: Request, context: { params: Promise<{ component: string }> }) {
  const { component } = await context.params;
  if (!isComponentID(component)) {
    return Response.json({ error: `invalid component id: ${component}` }, { status: 400 });
  }

  const spec = await readSpec(component);
  if (!spec) {
    return Response.json({ error: `openapi component not found: ${component}` }, { status: 404 });
  }

  if (spec.extension === 'json') {
    const localized = localizeOpenAPI(JSON.parse(spec.body), languageFromRequest(request));
    return Response.json(localized);
  }

  return new Response(spec.body, {
    headers: {
      'content-type': 'application/yaml; charset=utf-8',
    },
  });
}
