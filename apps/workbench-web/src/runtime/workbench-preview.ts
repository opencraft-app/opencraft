import { getAppearanceThemeSnapshot, setAppearanceThemeId, setThemePreference } from '../appearance-theme';

/** A frame-local presentation intent; routes, accounts and persisted preferences stay unchanged. */
export function isMobileWorkbenchPreview(target: Window = window): boolean {
  try {
    return target.parent !== target && target.parent.location.origin === target.location.origin
      && target.frameElement?.getAttribute('data-opencraft-preview') === 'mobile';
  } catch { return false; }
}

/** Keep the real appearance owner, and forward Escape to the existing parent ModalHost. */
export function bindWorkbenchPreview(target: Window = window): () => void {
  if (!isMobileWorkbenchPreview(target)) return () => {};
  const receive = (event: MessageEvent) => {
    if (event.origin !== target.location.origin || event.source !== target.parent
      || event.data?.type !== 'opencraft.preview.appearance') return;
    const { preference, themeId } = event.data;
    if (!['light','dark','system'].includes(preference) || typeof themeId !== 'string' || themeId.length > 200) return;
    const current = getAppearanceThemeSnapshot();
    if (current.preference !== preference) setThemePreference(preference);
    if (current.requestedThemeId !== themeId) setAppearanceThemeId(themeId);
  };
  const escape = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && !event.defaultPrevented) {
      target.parent.postMessage({ type: 'opencraft.preview.escape' }, target.location.origin);
    }
  };
  target.addEventListener('message',receive);
  target.addEventListener('keydown',escape);
  target.parent.postMessage({ type:'opencraft.preview.ready' },target.location.origin);
  return () => {
    target.removeEventListener('message',receive);
    target.removeEventListener('keydown',escape);
  };
}
