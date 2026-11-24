import { useEffect, useLayoutEffect, useId, useRef, useState } from 'react';
import type { EnvironmentDocument, EnvironmentVariableView } from '@opencraft/workbench-runtime';
import { SettingsPanel } from './settings-panel';
import { SettingsActions, SettingsButton, SettingsGroup, SettingsListItem, SettingsNotice, SettingsRow, SettingsSection, SettingsSelect, SettingsSwitch, SettingsTextInput } from './settings-controls';

export interface EnvironmentEditorLabels {
  title: string; scope: string; allProjects: string; description: string; variables: string;
  add: string; edit: string; remove: string; save: string; saving: string; cancel: string;
  name: string; value: string; secret: string; savedSecret: string; inherited: string;
  empty: string; loading: string; retry: string; failed: string; invalid: string; reserved: string; conflict: string;
}
export interface EnvironmentEditorPort {
  load(projectId: string | null, signal: AbortSignal): Promise<EnvironmentDocument>;
  save(document: EnvironmentDocument, variables: EnvironmentVariableView[], signal: AbortSignal): Promise<EnvironmentDocument>;
}
/** Account changes unmount this editor at the product boundary. Draft values
 * stay in component memory only, never browser storage or diagnostics. */
export function EnvironmentVariablesEditor({ port, labels: l, reportError, onStateChange }: {
  port: EnvironmentEditorPort; labels: EnvironmentEditorLabels;
  /** Hosts compose draft/pending protection with their existing navigation owner.
   * Only lifecycle flags leave the editor, never names or credential values. */
  onStateChange?(state: { dirty: boolean; writing: boolean }): void;
  reportError?(notice: { key: string; message: string }): void;
}) {
  const [projectId, setProjectId] = useState<string | null>(null);
  const [document, setDocument] = useState<EnvironmentDocument | null>(null);
  const [failed, setFailed] = useState(false), [retry, setRetry] = useState(0);
  const [draft, setDraft] = useState<{ original: string | null; name: string; value: string | null; secret: boolean } | null>(null);
  const [pending, setPending] = useState<string | null>(null), [validation, setValidation] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const requests = useRef(new Set<AbortController>());
  const generation = useRef(0);
  const id = useId();
  useLayoutEffect(() => {
    onStateChange?.({ dirty: draft !== null, writing: pending !== null });
  }, [draft !== null, pending !== null, onStateChange]);
  useLayoutEffect(() => () => onStateChange?.({ dirty: false, writing: false }), [onStateChange]);
  useEffect(() => {
    const current = ++generation.current, request = new AbortController(); requests.current.add(request);
    setFailed(false); setSaveError(null); setDraft(null); setDocument(null); setPending(null); setValidation(null);
    void port.load(projectId, request.signal).then(next => {
      if (!request.signal.aborted && current === generation.current) setDocument(next);
    }).catch(() => { if (!request.signal.aborted && current === generation.current) setFailed(true); })
      .finally(() => requests.current.delete(request));
    return () => { generation.current++; for (const operation of requests.current) operation.abort(); requests.current.clear(); };
  }, [port, projectId, retry]);
  const errorText = (error: unknown) => error instanceof Error && error.message === 'reserved' ? l.reserved
    : error instanceof Error && error.message === 'conflict' ? l.conflict : error instanceof Error && error.message === 'invalid' ? l.invalid : l.failed;
  const save = async (variables: EnvironmentVariableView[], key: string) => {
    if (!document || pending) return;
    const current = generation.current, request = new AbortController(); requests.current.add(request); setPending(key); setSaveError(null); setValidation(null);
    try {
      const next = await port.save(document, variables, request.signal);
      if (!request.signal.aborted && current === generation.current) { setDocument(next); if (key === 'draft') setDraft(null); setValidation(null); }
    } catch (error) {
      if (!request.signal.aborted && current === generation.current) {
        const message = errorText(error);
        if (key === 'draft' && error instanceof Error && ['invalid', 'reserved'].includes(error.message)) setValidation(message);
        else { setSaveError(message); reportError?.({ key: 'environment-variables', message }); }
      }
    } finally { requests.current.delete(request); if (current === generation.current) setPending(null); }
  };
  const edit = (item?: EnvironmentVariableView) => { setSaveError(null); setValidation(null); setDraft({ original: item?.name ?? null, name: item?.name ?? '', value: item ? item.value : '', secret: item?.secret ?? true }); };
  const own = new Set(document?.variables.map(item => item.name));
  const inherited = document?.inherited.filter(item => !own.has(item.name)) ?? [];
  // The scope control is the only member of its group, so the row label alone
  // names it; a section heading repeating the same word would be redundant.
  return <SettingsPanel title={l.title}>
    <SettingsGroup><SettingsRow layout="stacked" label={l.scope} description={l.description} htmlFor={`${id}-scope`}>
      <SettingsSelect id={`${id}-scope`} value={projectId ?? ''} disabled={!!pending || !!draft || !document}
        onChange={event => setProjectId(event.currentTarget.value || null)}>
        <option value="">{l.allProjects}</option>
        {document?.projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
      </SettingsSelect>
    </SettingsRow></SettingsGroup>
    <SettingsSection title={l.variables} action={<SettingsButton disabled={!document || !!pending || !!draft} onClick={() => edit()}>{l.add}</SettingsButton>}>
      {!document ? <SettingsNotice>{failed ? l.failed : l.loading}</SettingsNotice> : <SettingsGroup>
        {document.variables.length === 0 && inherited.length === 0 && !draft ? <SettingsRow label={l.empty} /> : null}
        {document.variables.map(item => <SettingsListItem key={item.name} label={item.name}
          description={item.secret ? '••••••••' : item.value} actions={<>
            <SettingsButton variant="quiet" disabled={!!pending || !!draft} onClick={() => edit(item)} aria-label={`${l.edit} ${item.name}`}>{l.edit}</SettingsButton>
            <SettingsButton variant="quiet" disabled={!!pending || !!draft} loading={pending === item.name}
              onClick={() => { void save(document.variables.filter(value => value.name !== item.name), item.name); }} aria-label={`${l.remove} ${item.name}`}>{l.remove}</SettingsButton>
          </>} />)}
        {inherited.map(item => <SettingsListItem key={`inherited:${item.name}`} label={item.name}
          description={item.secret ? '••••••••' : item.value} metadata={l.inherited} />)}
      </SettingsGroup>}
      {saveError ? <SettingsNotice tone="error" role="alert">{saveError}</SettingsNotice> : null}
      {failed ? <SettingsActions><SettingsButton onClick={() => setRetry(value => value + 1)}>{l.retry}</SettingsButton></SettingsActions> : null}
      {draft ? <form autoComplete="off" onSubmit={event => {
        event.preventDefault(); if (!document || pending) return;
        if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(draft.name) || document.variables.some(item => item.name === draft.name && item.name !== draft.original)) { setValidation(l.invalid); return; }
        const saved = document.variables.find(item => item.name === draft.original);
        if (saved?.secret && !draft.secret && draft.value === null) { setValidation(l.invalid); return; }
        const next = { name: draft.name, secret: draft.secret, value: draft.value };
        void save([...document.variables.filter(item => item.name !== draft.original), next], 'draft');
      }}>
        <SettingsGroup>
          <SettingsRow layout="stacked" label={l.name} htmlFor={`${id}-name`}><SettingsTextInput id={`${id}-name`} required maxLength={128} readOnly={draft.original !== null}
            value={draft.name} disabled={!!pending} onChange={event => { setDraft({ ...draft, name: event.currentTarget.value }); setValidation(null); }} /></SettingsRow>
          <SettingsRow layout="stacked" label={l.value} htmlFor={`${id}-value`}><SettingsTextInput id={`${id}-value`} type={draft.secret ? 'password' : 'text'} autoComplete="new-password"
            value={draft.value ?? ''} disabled={!!pending} maxLength={16_384} placeholder={draft.original && draft.secret ? l.savedSecret : undefined}
            aria-invalid={!!validation} aria-describedby={validation ? `${id}-validation` : undefined} onChange={event => { setDraft({ ...draft, value: event.currentTarget.value }); setValidation(null); }} /></SettingsRow>
          <SettingsRow label={l.secret}><SettingsSwitch checked={draft.secret} label={l.secret} disabled={!!pending} onCheckedChange={secret => setDraft({ ...draft, secret })} /></SettingsRow>
        </SettingsGroup>
        {validation ? <SettingsNotice id={`${id}-validation`} tone="error" role="status">{validation}</SettingsNotice> : null}
        <SettingsActions>
          <SettingsButton disabled={!!pending} onClick={() => { setDraft(null); setValidation(null); }}>{l.cancel}</SettingsButton>
          <SettingsButton type="submit" variant="primary" disabled={!!pending} loading={pending === 'draft'}>{pending === 'draft' ? l.saving : l.save}</SettingsButton>
        </SettingsActions>
      </form> : null}
    </SettingsSection>
  </SettingsPanel>;
}
