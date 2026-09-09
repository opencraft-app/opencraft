/** UI rollout only. Server ownership, eligibility and payment checks remain authoritative. */
const productionCanaryUsers = new Set(['usr_143e96b636afd48b3addc752']);
const testingHosts = new Set(['localhost', '127.0.0.1', 'lightclaw.pages.dev']);

export function isPassUpgradeVisible(
  userId: string | null | undefined,
  hostname = typeof location === 'undefined' ? '' : location.hostname,
): boolean {
  if (!userId) return false;
  if (testingHosts.has(hostname)) return true;
  return (hostname === 'lightvela.com' || hostname === 'www.lightvela.com') && productionCanaryUsers.has(userId);
}
