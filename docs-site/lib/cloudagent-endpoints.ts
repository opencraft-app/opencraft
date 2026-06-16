export type CloudAgentEndpoint = {
  method: 'GET' | 'POST';
  path: string;
  purpose: string;
  auth: 'scope';
  stability: 'v1';
  source_path: string;
};

export const cloudAgentEndpoints: CloudAgentEndpoint[] = [
  {
    method: 'GET',
    path: '/v1/cloudagent/capabilities',
    purpose: 'Probe CloudAgent HTTP Run protocol support and feature flags.',
    auth: 'scope',
    stability: 'v1',
    source_path: 'cloudagent/gateway/docs/cloudagent-http-run-integration.md',
  },
  {
    method: 'GET',
    path: '/v1/cloudagent/sessions',
    purpose: 'List caller-scoped CloudAgent sessions.',
    auth: 'scope',
    stability: 'v1',
    source_path: 'cloudagent/gateway/docs/cloudagent-http-run-integration.md',
  },
  {
    method: 'POST',
    path: '/v1/cloudagent/sessions',
    purpose: 'Create a CloudAgent session.',
    auth: 'scope',
    stability: 'v1',
    source_path: 'cloudagent/gateway/docs/cloudagent-http-run-integration.md',
  },
  {
    method: 'GET',
    path: '/v1/cloudagent/sessions/{session_id}',
    purpose: 'Load a caller-scoped CloudAgent session.',
    auth: 'scope',
    stability: 'v1',
    source_path: 'cloudagent/gateway/docs/cloudagent-http-run-integration.md',
  },
  {
    method: 'POST',
    path: '/v1/cloudagent/sessions/{session_id}/runs',
    purpose: 'Submit an idempotent durable run to a session.',
    auth: 'scope',
    stability: 'v1',
    source_path: 'cloudagent/gateway/docs/cloudagent-http-run-integration.md',
  },
  {
    method: 'GET',
    path: '/v1/cloudagent/runs',
    purpose: 'List caller-scoped durable runs, optionally filtered by session.',
    auth: 'scope',
    stability: 'v1',
    source_path: 'cloudagent/gateway/docs/cloudagent-http-run-integration.md',
  },
  {
    method: 'GET',
    path: '/v1/cloudagent/runs/{run_id}',
    purpose: 'Read durable run status.',
    auth: 'scope',
    stability: 'v1',
    source_path: 'cloudagent/gateway/docs/cloudagent-http-run-integration.md',
  },
  {
    method: 'GET',
    path: '/v1/cloudagent/runs/{run_id}/events?after_seq=N',
    purpose: 'Replay run events after a committed sequence number.',
    auth: 'scope',
    stability: 'v1',
    source_path: 'cloudagent/gateway/docs/cloudagent-http-run-integration.md',
  },
  {
    method: 'GET',
    path: '/v1/cloudagent/runs/{run_id}/events?after_seq=N&stream=true',
    purpose: 'Stream run events as newline-delimited JSON after a sequence number.',
    auth: 'scope',
    stability: 'v1',
    source_path: 'cloudagent/gateway/docs/cloudagent-http-run-integration.md',
  },
  {
    method: 'GET',
    path: '/v1/cloudagent/runs/{run_id}/result',
    purpose: 'Read the final durable run result.',
    auth: 'scope',
    stability: 'v1',
    source_path: 'cloudagent/gateway/docs/cloudagent-http-run-integration.md',
  },
  {
    method: 'POST',
    path: '/v1/cloudagent/runs/{run_id}/cancel',
    purpose: 'Request cancellation for a durable run.',
    auth: 'scope',
    stability: 'v1',
    source_path: 'cloudagent/gateway/docs/cloudagent-http-run-integration.md',
  },
];
