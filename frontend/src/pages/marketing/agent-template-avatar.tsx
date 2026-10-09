import type { HermesHomepageMascot } from '@/lib/hermes-appearance';
import { assetUrl } from '@/lib/asset-url';

const TEMPLATE_MASCOTS: Readonly<Record<string, HermesHomepageMascot>> = {
  'health-keeper': 'cloud-butter',
  'market-watcher': 'drop-sky',
  'parenting-advisor': 'round-coral',
  'industry-researcher': 'square-mint',
  'anti-fraud-guard': 'bean-lilac',
  'morning-briefing': 'bean-lilac',
  'ai-study-buddy': 'square-mint',
  'dev-companion': 'bean-periwinkle',
  'growth-experimenter': 'cloud-butter',
  'social-inspiration': 'round-peach',
};

/** Reuse the approved homepage characters as template portraits. */
export function AgentTemplateAvatar({ templateId, size = 40 }: { templateId: string; size?: number }) {
  const mascot = TEMPLATE_MASCOTS[templateId] ?? 'square-mint';
  return <AgentHomepageAvatar mascot={mascot} size={size} />;
}

export function AgentHomepageAvatar({ mascot, size = 40 }: { mascot: HermesHomepageMascot; size?: number }) {
  return <span aria-hidden="true" className="relative inline-block shrink-0 overflow-hidden rounded-full bg-[#f4f0fa]" style={{ width: size, height: size }}>
    <img src={assetUrl(`/lightvela-intl-home/assets/peek-friends/${mascot}.webp`)} alt="" draggable={false}
      className="absolute max-w-none object-contain" style={{ width: size * 1.6, height: size * 1.6, left: '50%', top: -size * .4, transform: 'translateX(-50%)' }} />
  </span>;
}
