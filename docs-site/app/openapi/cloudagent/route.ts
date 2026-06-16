import cloudagentOpenAPI from '@/openapi/cloudagent.json';
import { languageFromRequest } from '@/lib/language';
import { localizeOpenAPI } from '@/lib/openapi-localize';

export const revalidate = false;

export function GET(request: Request) {
  return Response.json(localizeOpenAPI(cloudagentOpenAPI, languageFromRequest(request)));
}
