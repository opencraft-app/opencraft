import { useShellPresentation } from './shell-presentation';

/** Compatibility name: consume Shell's space projection, never a device breakpoint. */
export function useTouchBrowserLayout() {
  return useShellPresentation()?.touchScene ?? false;
}
