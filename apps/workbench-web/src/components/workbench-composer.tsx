import { createContext, forwardRef, useContext, type ComponentProps } from 'react';
import { OpenCraftComposer, type OpenCraftComposerHandle, type OpenCraftComposerProps } from '@opencraft/composer-editor';
import { ComposerExtensionActions } from '../runtime/composer-action-renderers';
import { ComposerPanelToggle } from './composer-panel-toggle';

type ActionEnvironment = Pick<ComponentProps<typeof ComposerExtensionActions>, 'actionIds' | 'registry' | 'platform'>;
export interface WorkbenchComposerEnvironment extends ActionEnvironment {
  readonly navigationEnabled: boolean;
}

// Share capabilities, never a controller: every conversation supplies its own
// draft and submit/interrupt callbacks, including extension (e.g. dictation) input.
const Environment = createContext<WorkbenchComposerEnvironment | null>(null);
export const WorkbenchComposerProvider = Environment.Provider;

export const WorkbenchComposer = forwardRef<OpenCraftComposerHandle, OpenCraftComposerProps & {
  actionsDisabled?: boolean;
  navigationForeground?: 'primary' | 'tools';
}>(function WorkbenchComposer({ actionsDisabled = false, navigationForeground = 'primary', endActions, navigationActions, ...props }, ref) {
  const environment = useContext(Environment);
  return <OpenCraftComposer mentionSuggestionsEnabled={false} {...props} ref={ref}
    endActions={<>{endActions}{environment ? <ComposerExtensionActions
      actionIds={environment.actionIds} registry={environment.registry} platform={environment.platform}
      controller={props.controller} disabled={actionsDisabled} /> : null}</>}
    navigationActions={navigationActions !== undefined ? navigationActions : environment?.navigationEnabled
      ? <ComposerPanelToggle foreground={navigationForeground} /> : null}
  />;
});
