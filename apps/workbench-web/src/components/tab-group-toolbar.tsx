import { createPortal } from 'react-dom';
import './tab-group-toolbar.scss';
import { useEffect, useState, type ReactNode } from 'react';
import { useBrowserComposerMotion, type BrowserComposerTransition } from './use-browser-composer-motion';
import { ControlSurface } from '@opencraft/design-system-web/control-surface';

/** Scene slots share one trailing tab entrance; tab state stays with its owner. */
export function TabGroupToolbar({ label, leading, content, contextualActions, tabSwitcher, headerHost, switcherHost, transition, editing = false }: {
  readonly label: string;
  readonly transition?: BrowserComposerTransition;
  readonly switcherHost?: HTMLElement | null;
  readonly headerHost?: HTMLElement | null;
  readonly leading: ReactNode;
  readonly content: ReactNode;
  readonly contextualActions?: ReactNode;
  readonly tabSwitcher: ReactNode;
  readonly editing?: boolean;
}) {
  const [dock, setDock] = useState<HTMLDivElement | null>(null);
  const [controlsCarrier] = useState(() => { const node = document.createElement('div'); node.style.display = 'contents'; return node; });
  const [switcherCarrier] = useState(() => { const node = document.createElement('div'); node.style.display = 'contents'; return node; });
  useEffect(() => () => { controlsCarrier.remove(); switcherCarrier.remove(); }, [controlsCarrier, switcherCarrier]);
  useBrowserComposerMotion(dock, controlsCarrier, switcherCarrier, headerHost, switcherHost, transition);
  const controls = <ControlSurface surface={headerHost ? 'integrated' : 'floating'} className={`panel-mobile-dock__address${headerHost ? " panel-mobile-dock__address--integrated" : ""}`}>
      {leading}
      <div className="panel-mobile-dock__content">{content}</div>
      <nav className="panel-mobile-dock__actions" aria-label={label}>
        <div className="panel-mobile-dock__contextual-actions" hidden={editing}>{contextualActions}</div>
      </nav>
    </ControlSurface>;
  return <div ref={setDock} className="panel-mobile-dock" data-composer-integrated={!!headerHost || undefined}>
    {createPortal(controls, controlsCarrier)}
    {createPortal(tabSwitcher, switcherCarrier)}
  </div>;
}
