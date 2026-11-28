import { useEffect, useMemo, useRef, useState } from 'react';
import type { ComposerExecutionTarget } from '@opencraft/composer-core';
import type { WorkspaceCatalog } from '@opencraft/appserver-protocol';
import { FormattedMessage, useIntl } from '@opencraft/i18n/react';
import { DisclosureButton } from '@opencraft/design-system-web/button';
import * as Menu from '@opencraft/design-system-web/dropdown-menu';
import { CheckIcon, ChevronDownIcon, ChevronLeftIcon, FolderIcon, NewFolderIcon, SearchIcon } from '@opencraft/design-system-web/action-icons';
import { menuGeometry } from '@opencraft/design-system/tokens';
import { buildWorkspaceChoices, selectWorkspaceChoice, temporaryWorkspaceChoice, workspaceChoiceSelected, type WorkspaceChoice } from '../runtime/workspace-placement-model';
import type { DraftWorkspaceOption } from '../runtime/draft-workspace-model';
import { useAsyncNotices } from './async-notices-context';

export interface WorkspacePlacementControl {
  readonly catalog?: WorkspaceCatalog;
  readonly available: boolean;
  readonly selectable: boolean;
  readonly loading: boolean;
  readonly error: Error | null;
  refresh(): void;
  select(execution: ComposerExecutionTarget): void;
}

/** One location picker owns directory, environment and optional source together. */
export function WorkspacePlacementPicker({ control, execution, locked, portalContainer, onReturnFocus,
  workspaceOptions, workspaceOptionsLoading, canBrowse, nativeWorkspacePicking, onBrowseWorkspace, onSelectWorkspace,
  open: controlledOpen, onOpenChange: controlledOnOpenChange,
}: {
  control?: WorkspacePlacementControl; execution: ComposerExecutionTarget; locked: boolean;
  portalContainer: HTMLElement | null; onReturnFocus(): void;
  workspaceOptions: readonly DraftWorkspaceOption[]; workspaceOptionsLoading: boolean;
  canBrowse: boolean; nativeWorkspacePicking: boolean;
  onBrowseWorkspace(): void | Promise<void>; onSelectWorkspace(workspace: DraftWorkspaceOption): void;
  open?: boolean; onOpenChange?: (open: boolean) => void;
}) {
  const intl = useIntl(), notices = useAsyncNotices();
  const [internalOpen, setInternalOpen] = useState(false), [creating, setCreating] = useState(false), [query, setQuery] = useState('');
  const open = controlledOpen ?? internalOpen;
  const setOpen = (next: boolean) => {
    if (controlledOpen === undefined) setInternalOpen(next);
    controlledOnOpenChange?.(next);
  };
  const [picking, setPicking] = useState(false);
  const search = useRef<HTMLInputElement>(null);
  const catalog = control?.catalog;
  const choices = useMemo(() => buildWorkspaceChoices(workspaceOptions, catalog), [workspaceOptions, catalog]);
  const selected = choices.find(choice => workspaceChoiceSelected(choice, execution));
  const source = execution.workspace.source;
  const temporary = intl.formatMessage({ id: 'workspacePlacement.temporary', defaultMessage: 'Temporary workspace' });
  const host = intl.formatMessage({ id: 'workspacePlacement.host', defaultMessage: 'Host' });
  const environmentName = catalog?.environments.find(entry => entry.target.configurationId === execution.environment?.configurationId)?.name;
  const currentLabel = selected?.label
    ?? (source?.libraryId ? catalog?.libraries.find(entry => entry.id === source.libraryId)?.name : undefined)
    ?? (source?.kind === 'git' ? source.repositoryId : source?.libraryId)
    ?? execution.workspace.cwd?.split(/[\\/]+/u).filter(Boolean).at(-1)
    ?? temporary;
  const matches = choices.filter(choice => `${choice.label} ${choice.detail}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const retainedVisible = !selected && `${currentLabel} ${environmentName ?? execution.environment?.configurationId ?? host} ${execution.workspace.cwd ?? ''}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  const notify = (id: string, defaultMessage: string) => notices.error({ key: 'workspace-selection', message: intl.formatMessage({ id, defaultMessage }) });
  const choose = (choice: WorkspaceChoice, event: Event) => {
    try {
      const directory = !choice.environment && choice.workspace.cwd !== null
        ? workspaceOptions.find(option => option.cwd === choice.workspace.cwd) : undefined;
      // Keep the existing directory preference and browsing transaction owner.
      if (directory) onSelectWorkspace(directory);
      else if (control) control.select(selectWorkspaceChoice(execution, choice, catalog));
    } catch {
      event.preventDefault();
      notify('workspacePlacement.selectionFailed', 'Could not select this workspace. Refresh and try again.');
    }
  };
  useEffect(() => {
    if (!open || creating) return;
    const frame = requestAnimationFrame(() => search.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open, creating]);
  useEffect(() => {
    if (open && control?.error) notices.error({ key: 'workspace-catalog', message: intl.formatMessage({
      id: 'workspacePlacement.unavailable', defaultMessage: 'Workspace choices are unavailable. Your selection is retained.',
    }) });
  }, [open, control?.error, intl, notices]);
  useEffect(() => { setOpen(false); setQuery(''); setCreating(false); }, [execution.hostId]);
  return <Menu.Root open={open} onOpenChange={next => {
    setOpen(next); setQuery(''); setCreating(false);
    if (next) control?.refresh();
  }}>
    <Menu.Trigger asChild><DisclosureButton className="new-thread-context-trigger" disabled={locked}
      aria-label={intl.formatMessage({ id: 'workspacePlacement.choose', defaultMessage: 'Choose workspace' })}
      title={[currentLabel, environmentName ?? host, execution.workspace.cwd].filter(Boolean).join(' · ')}>
      <FolderIcon size={15} /><span>{currentLabel}</span><ChevronDownIcon size={12} />
    </DisclosureButton></Menu.Trigger>
    <Menu.Portal container={portalContainer}><Menu.Content className="new-thread-project-menu" align="start" side="top"
      sideOffset={menuGeometry.rootSideOffset} collisionPadding={menuGeometry.collisionPadding}
      onCloseAutoFocus={event => { event.preventDefault(); onReturnFocus(); }}>
      {creating ? <>
        <Menu.Item className="new-thread-project-menu__item" onSelect={event => { event.preventDefault(); setCreating(false); }}>
          <ChevronLeftIcon size={15} /><FormattedMessage id="navigation.back" defaultMessage="Back" />
        </Menu.Item>
        <Menu.Label className="new-thread-project-menu__heading"><FormattedMessage id="workspacePlacement.createIn" defaultMessage="Create temporary workspace in" /></Menu.Label>
        <div className="new-thread-project-menu__items">
          <Menu.Item className="new-thread-project-menu__item" disabled={locked} onSelect={event => choose(temporaryWorkspaceChoice(), event)}>
            <span>{host}</span>
          </Menu.Item>
          {catalog?.environments.map(entry => <Menu.Item key={JSON.stringify(entry.target)} className="new-thread-project-menu__item"
            disabled={locked || !control?.selectable} onSelect={event => choose(temporaryWorkspaceChoice(entry.target), event)}>
            <span>{entry.name}</span>
          </Menu.Item>)}
        </div>
      </> : <>
        <Menu.Label className="new-thread-project-menu__heading"><FormattedMessage id="workspacePlacement.choose" defaultMessage="Choose workspace" /></Menu.Label>
        <label className="new-thread-project-menu__search">
          <SearchIcon size={14} />
          <input ref={search} value={query} type="search"
            aria-label={intl.formatMessage({ id: 'workspacePlacement.search', defaultMessage: 'Search workspaces' })}
            placeholder={intl.formatMessage({ id: 'workspacePlacement.search', defaultMessage: 'Search workspaces' })}
            onChange={event => setQuery(event.currentTarget.value)} onKeyDown={event => {
              if (event.key === 'Escape' || event.nativeEvent.isComposing) return;
              event.stopPropagation();
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                event.currentTarget.closest('[role="menu"]')?.querySelector<HTMLElement>('[role="menuitem"]:not([data-disabled])')?.focus();
              }
            }} />
        </label>
        <div className="new-thread-project-menu__items">
          {retainedVisible ?
            <Menu.Item className="new-thread-project-menu__item" data-selected="true" disabled={locked}>
              <FolderIcon size={15} /><span><strong>{currentLabel}</strong><small>{[environmentName ?? execution.environment?.configurationId ?? host, execution.workspace.cwd].filter(Boolean).join(' · ')}</small></span><CheckIcon size={15} />
            </Menu.Item> : null}
          {matches.map(choice => <Menu.Item key={choice.id} className="new-thread-project-menu__item" title={`${choice.label} · ${choice.detail}`}
            data-selected={workspaceChoiceSelected(choice, execution) || undefined}
            disabled={locked || (!!choice.environment && !control?.selectable)} onSelect={event => choose(choice, event)}>
            <FolderIcon size={15} /><span><strong>{choice.label}</strong><small>{choice.environment ? choice.detail : `${host} · ${choice.detail}`}</small></span>
            {workspaceChoiceSelected(choice, execution) ? <CheckIcon size={15} /> : null}
          </Menu.Item>)}
          {!matches.length && !retainedVisible && !workspaceOptionsLoading && !control?.loading ? <div className="new-thread-project-menu__state"><FormattedMessage id="workspacePlacement.noMatches" defaultMessage="No matching workspaces" /></div> : null}
        </div>
        <Menu.Separator className="new-thread-project-menu__separator" />
        {control ? <Menu.Item className="new-thread-project-menu__item" disabled={locked}
          onSelect={event => { event.preventDefault(); setCreating(true); }}>
          <NewFolderIcon size={15} /><FormattedMessage id="workspacePlacement.newTemporary" defaultMessage="New temporary workspace…" />
        </Menu.Item> : null}
        <Menu.Item className="new-thread-project-menu__item" disabled={locked || picking || !canBrowse}
          onSelect={() => {
            setPicking(true);
            Promise.resolve().then(onBrowseWorkspace).catch(() => notify('workspacePlacement.browseFailed', 'Could not open the folder picker. Try again.')).finally(() => setPicking(false));
          }}>
          <FolderIcon size={15} /><span><strong><FormattedMessage id="workspacePlacement.openFolder" defaultMessage="Open folder…" /></strong>
            <small>{nativeWorkspacePicking
              ? intl.formatMessage({ id: 'draft.chooseFolderOnDevice', defaultMessage: 'Choose a folder on this device' })
              : intl.formatMessage({ id: 'draft.chooseFolderFromNode', defaultMessage: 'Choose a folder from this node' })}</small></span>
        </Menu.Item>
        {control && (control.available || catalog) ? <Menu.Item className="new-thread-project-menu__item" disabled={!control.available || control.loading} onSelect={event => { event.preventDefault(); control.refresh(); }}>
          <FormattedMessage id="workspacePlacement.refresh" defaultMessage="Refresh workspaces" />
        </Menu.Item> : null}
      </>}
    </Menu.Content></Menu.Portal>
  </Menu.Root>;
}
