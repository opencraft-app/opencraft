import { useSyncExternalStore } from 'react';

// Consume the installation's existing density/Newera projection. Window width
// only selects chrome; it never changes the shared remote page's viewport.
const query = '(max-width: 767px)';
function snapshot() {
  const root = document.documentElement;
  return root.dataset.uiDensity === 'touch' && root.dataset.touchNewera === 'on'
    && window.matchMedia(query).matches;
}
function subscribe(listener: () => void) {
  const media = window.matchMedia(query);
  const observer = new MutationObserver(listener);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-ui-density', 'data-touch-newera'] });
  media.addEventListener('change', listener);
  return () => { observer.disconnect(); media.removeEventListener('change', listener); };
}
export function useNeweraBrowserLayout() {
  return useSyncExternalStore(subscribe, snapshot, () => false);
}
