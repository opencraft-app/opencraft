import { DOCS_ROUTE_SLUGS } from './docs-route-manifest';

const SHARED_RETIRED_ROUTE_SLUGS = [
  ['advanced', 'agent-workflow-design'],
  ['advanced', 'automation-fit'],
  ['advanced', 'models-skills-automation'],
  ['advanced', 'multi-channel-hermes'],
  ['advanced', 'reduce-model-cost'],
  ['compare', 'ai-agent-vs-chatbot'],
  ['compare', 'cloud-vs-local-agent'],
  ['compare', 'lightvela-vs-self-hosting-hermes'],
  ['compare', 'lightvela-vs-server-hosting'],
  ['compare', 'model-selection'],
  ['configuration', 'channel-slack'],
  ['security', 'data-protection'],
  ['security', 'data-storage'],
  ['security', 'export-and-delete-data'],
  ['security', 'instance-isolation'],
  ['security', 'model-training-policy'],
  ['support', 'report-an-issue'],
  ['faq'],
  ['troubleshooting', 'agent-not-responding'],
  ['troubleshooting', 'automation-not-running'],
  ['troubleshooting', 'channel-connection-failed'],
  ['troubleshooting', 'model-errors'],
  ['troubleshooting', 'rebuild-hermes'],
  ['troubleshooting', 'skill-installation-failed'],
] as const;

const SECONDARY_USE_CASE_RETIRED_ROUTE_SLUGS = [
  ['use-cases', 'chinese-messaging-channels'],
  ['use-cases', 'daily-summary'],
  ['use-cases', 'hermes-agent-24-7'],
  ['use-cases', 'memory-and-knowledge'],
  ['use-cases', 'work-assistant'],
] as const;

export const DOCS_RETIRED_ROUTE_SLUGS = {
  'en-us': [...SHARED_RETIRED_ROUTE_SLUGS, ...SECONDARY_USE_CASE_RETIRED_ROUTE_SLUGS],
  'zh-cn': [],
  'zh-sg': [...SHARED_RETIRED_ROUTE_SLUGS, ...SECONDARY_USE_CASE_RETIRED_ROUTE_SLUGS],
} as const;

export const DOCS_STATIC_ROUTE_SLUGS = {
  'en-us': [...DOCS_ROUTE_SLUGS['en-us'], ...DOCS_RETIRED_ROUTE_SLUGS['en-us']],
  'zh-cn': DOCS_ROUTE_SLUGS['zh-cn'],
  'zh-sg': [...DOCS_ROUTE_SLUGS['zh-sg'], ...DOCS_RETIRED_ROUTE_SLUGS['zh-sg']],
} as const;
