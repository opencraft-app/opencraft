import './tab-group-toolbar.scss';
import type { ReactNode } from 'react';
import { ControlSurface } from '@opencraft/design-system-web/control-surface';

/** Scene slots share one trailing tab entrance; tab state stays with its owner. */
export function TabGroupToolbar({ label, leading, content, contextualActions, tabSwitcher, editing = false }: {
  readonly label: string;
  readonly leading: ReactNode;
  readonly content: ReactNode;
  readonly contextualActions?: ReactNode;
  readonly tabSwitcher: ReactNode;
  readonly editing?: boolean;
}) {
  return <div className="panel-mobile-dock">
    <ControlSurface surface="floating" className="panel-mobile-dock__address">
      {leading}
      <div className="panel-mobile-dock__content">{content}</div>
      <nav className="panel-mobile-dock__actions" aria-label={label}>
        <div className="panel-mobile-dock__contextual-actions" hidden={editing}>{contextualActions}</div>
        {tabSwitcher}
      </nav>
    </ControlSurface>
  </div>;
}
