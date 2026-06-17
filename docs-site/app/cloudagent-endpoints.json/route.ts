import { languageFromRequest } from '@/lib/language';
import { localizeOpenAPI } from '@/lib/openapi-localize';
import spec from '@/openapi/cloudagent.json';

export const revalidate = false;

export function GET(request: Request) {
  const localizedSpec = localizeOpenAPI(spec, languageFromRequest(request));
  const paths = localizedSpec.paths as Record<string, Record<string, { summary?: string; description?: string }>>;
  const data = Object.entries(paths).flatMap(([path, operations]) =>
    Object.entries(operations).map(([method, operation]) => ({
      method: method.toUpperCase(),
      path,
      purpose: operation.description ?? operation.summary ?? '',
      auth: 'scope',
      stability: 'v1',
      source_path: 'docs-site/openapi/cloudagent.json',
    })),
  );

  return Response.json({
    object: 'cloudagent.endpoint_manifest',
    version: 'v1',
    base_path: '/v1/cloudagent',
    generated_from: 'docs-site/openapi/cloudagent.json',
    data,
  });
}
