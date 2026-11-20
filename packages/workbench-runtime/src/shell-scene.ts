import type { ShellSpaceProjection } from './shell-space';

export type ShellForeground = 'primary' | 'tools';
export type ShellContentPresentation =
  | { readonly kind: 'primary'; readonly foreground: 'primary' }
  | { readonly kind: 'tools'; readonly foreground: 'tools' }
  | { readonly kind: 'split'; readonly foreground: ShellForeground };

/** Width only changes this projection. It cannot write preferences or dispose resources. */
export function projectShellScene(input: {
  readonly space: ShellSpaceProjection;
  readonly foreground: ShellForeground;
  readonly toolsAvailable: boolean;
  readonly toolsOpen: boolean;
  readonly toolsMaximized: boolean;
  readonly touch: boolean;
}) {
  const { space, foreground } = input;
  const content: ShellContentPresentation = !input.toolsAvailable || (!input.toolsOpen && foreground !== 'tools')
    ? { kind: 'primary', foreground: 'primary' }
    : !input.toolsMaximized && (space.rightOpen || (!input.toolsOpen && space.rightAvailable))
      ? { kind: 'split', foreground: foreground }
      : foreground === 'tools' ? { kind: 'tools', foreground: 'tools' } : { kind: 'primary', foreground: 'primary' };
  return {
    content,
    rightPanelOpen: content.kind !== 'primary',
    rightPanelFullWidth: content.kind === 'tools',
    touchScene: input.touch && (content.kind === 'tools' || !space.rightAvailable),
    overviewPresentation: space.rightAvailable && content.kind !== 'tools' ? 'contained' as const : 'fullscreen' as const,
  };
}
