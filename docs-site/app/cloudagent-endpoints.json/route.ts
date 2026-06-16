import { cloudAgentEndpoints } from '@/lib/cloudagent-endpoints';

export const revalidate = false;

export function GET() {
  return Response.json({
    object: 'cloudagent.endpoint_manifest',
    version: 'v1',
    base_path: '/v1/cloudagent',
    data: cloudAgentEndpoints,
  });
}
