import cloudagentOpenAPI from '@/openapi/cloudagent.json';

export const revalidate = false;

export function GET() {
  return Response.json(cloudagentOpenAPI);
}
