import { useEffect, useRef, useState, useSyncExternalStore, type MutableRefObject } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { ModalContent } from '@opencraft/design-system-web/modal-content';
import { CompanionAvatar } from '@opencraft/design-system-web/companion-avatar';
import {
  SettingsButton,
  SettingsPanel,
  SettingsTextInput,
  SettingsChoiceSelect,
  SettingsSection,
  SettingsGroup,
  SettingsRow,
} from '@opencraft/extension-react';
import { useIntl } from '@opencraft/i18n/react';
import { createClientId } from '@opencraft/composer-core';
import type {
  AssistantPresetId,
  BotEnvironment,
  BotEnvironmentCatalog,
  PersonalAssistantModelCatalog,
  PersonalAssistantStatus,
} from '@opencraft/appserver-protocol';
import type { ChannelRpc } from './channel-client';
import type { ChannelRead } from './channel-runtime';
import { AssistantMemory } from './assistant-memory';
import { AssistantThreadSettings } from './assistant-thread-settings';
import {
  formatAssistantDisplayName,
  formatEnvironmentLabel,
  isAssistantPaused,
  normalizeAssistantActor,
  upsertAssistantStatusList,
} from './assistant-actors';
import './managed-bots.scss';

const labels = {
  title: 'Additional assistants',
  create: 'New assistant',
  name: 'Name',
  duties: 'Responsibilities',
  environment: 'Work environment',
  local: 'Local machine',
  localHint: 'Local means the assistant execution Host, not this browser or phone.',
  sandboxHint:
    'This workspace is temporary and may be lost after a pause, restart or lease expiry. History and memory are retained. Commands with an unknown outcome are never replayed automatically.',
  e2bUnavailable:
    'E2B templates appear when a sandbox execution provider is connected. An unavailable environment never falls back to local execution.',
  empty: 'Create another assistant with its own identity, model, memory and conversation.',
  settings: 'Settings',
  chat: 'Chat',
  save: 'Save',
  cancel: 'Cancel',
  pause: 'Pause',
  resume: 'Resume',
  paused: 'Paused',
  memory: 'Memory',
  close: 'Close',
  loading: 'Loading…',
  failed: 'Could not complete the request. Refresh or retry; do not create a new request for an unconfirmed result.',
  retry: 'Retry',
  chooseModel: 'Choose a model',
  model: 'Model',
  unavailable: 'Unavailable',
  saved: 'Saved',
  noModel: 'No model selected',
  revision: 'Settings changed. Close and reopen settings before saving again.',
  privacy:
    'Each assistant has its own private conversation and memory. Group membership does not grant access to private memory.',
  legacy: 'Your default personal assistant is unchanged.',
  settingsImpact:
    'Saving restarts this assistant and requires renewed task authorization. Its history and memory are retained.',
};

const modelMessages = {
  personal: { id: 'agents.personal', defaultMessage: 'Personal assistant' },
  modelAbout: {
    id: 'people.modelAbout',
    defaultMessage: 'New requests use this model. Tasks already in progress are not affected.',
  },
  noModels: {
    id: 'people.noModels',
    defaultMessage: 'No model is available yet. Ask your administrator to set one up.',
  },
  modelServiceUnavailable: {
    id: 'people.modelServiceUnavailable',
    defaultMessage: 'Models could not be read right now. Close and reopen settings to try again.',
  },
  modelUnavailable: {
    id: 'people.modelUnavailable',
    defaultMessage: 'Selected model is unavailable',
  },
  modelFailed: {
    id: 'people.modelFailed',
    defaultMessage: 'The model was not saved. Choose it again.',
  },
};

type Editor = {
  status?: PersonalAssistantStatus;
  name: string;
  duties: string;
  environment: BotEnvironment;
};

export interface ManagedBotsActions {
  create(): void;
  hirePreset(presetId: AssistantPresetId): Promise<void>;
  retry(): void;
  openChat(botId: string): Promise<void>;
  openSettings(botId: string): void;
  openMemory(botId: string): void;
  togglePause(botId: string): Promise<void>;
}

export interface AssistantActorBusyState {
  readonly busy: boolean;
  readonly activeBotId: string | null;
  readonly activePresetId: AssistantPresetId | null;
  readonly operation: 'open' | 'pause' | 'hire' | null;
  readonly error?: string;
}

/**
 * Unified `AssistantActor` (`session://`) mutation, settings, and memory controller.
 * Both `singleton-per-human` presets (Personal Assistant) and `multi` custom assistants
 * share the same settings dialog, environment binding, model selection, memory viewer,
 * pause/resume lifecycle, and direct-chat contract.
 */
export function ManagedBots({
  rpc,
  signal,
  onOpen,
  botsResource,
  actionsRef,
  onStateChange,
}: {
  rpc: ChannelRpc;
  signal: AbortSignal;
  onOpen: (id: string) => void;
  botsResource?: ChannelRead<PersonalAssistantStatus[]>;
  actionsRef?: MutableRefObject<ManagedBotsActions | null>;
  onStateChange?: (state: AssistantActorBusyState) => void;
}) {
  const intl = useIntl();
  const f = (k: keyof typeof labels) => intl.formatMessage({ id: 'bots.manage.' + k, defaultMessage: labels[k] });
  const personalTitle = intl.formatMessage(modelMessages.personal);
  const noopSub = () => () => {};
  const emptyState = { value: undefined, failed: false, authoritative: false };
  const replica = useSyncExternalStore(
    botsResource ? botsResource.subscribe : noopSub,
    botsResource ? botsResource.get : () => emptyState,
    () => emptyState,
  );
  const [localRows, setLocalRows] = useState<PersonalAssistantStatus[]>();
  const [localFailed, setLocalFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [activeBotId, setActiveBotId] = useState<string | null>(null);
  const [activePresetId, setActivePresetId] = useState<AssistantPresetId | null>(null);
  const [operation, setOperation] = useState<'open' | 'pause' | 'hire' | null>(null);
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState('');

  const rows = botsResource ? replica.value : localRows;
  const failed = botsResource ? replica.failed && !replica.value : localFailed;

  const [editor, setEditor] = useState<Editor>();
  const [catalog, setCatalog] = useState<BotEnvironmentCatalog>();
  const [models, setModels] = useState<PersonalAssistantModelCatalog>();
  const [modelsLoading, setModelsLoading] = useState(false);
  const [memory, setMemory] = useState<PersonalAssistantStatus>();

  const life = useRef<AbortController | null>(null);
  const lock = useRef(false);
  const refreshing = useRef(false);
  const memoryGuard = useRef<(() => boolean) | null>(null);
  const creation = useRef<{ payload: string; id: string } | null>(null);
  const presetHireKey = useRef<Record<string, string>>({});
  const editorEpoch = useRef(0);

  const request = () => {
    const c = life.current;
    if (!c || c.signal.aborted || signal.aborted) throw Error('Retired');
    return c.signal;
  };

  function commitReplicaRow(updated: PersonalAssistantStatus) {
    if (!updated?.assistant) return;
    if (botsResource) {
      botsResource.set(upsertAssistantStatusList(botsResource.get().value, updated));
    } else {
      setLocalRows(prev => upsertAssistantStatusList(prev, updated));
    }
  }

  async function refresh() {
    if (botsResource) {
      await botsResource.refresh();
      return;
    }
    if (refreshing.current) return;
    refreshing.current = true;
    try {
      const s = request();
      await rpc.connect();
      const result = await rpc.request('opencraft/personal-assistant/bots/list', {}, s);
      if (!s.aborted) {
        setLocalRows((result?.bots ?? []).filter(r => Boolean(r?.assistant)));
        setLocalFailed(false);
      }
    } catch {
      if (life.current && !life.current.signal.aborted) setLocalFailed(true);
    } finally {
      refreshing.current = false;
    }
  }

  useEffect(() => {
    const c = new AbortController();
    life.current = c;
    const retire = () => c.abort();
    signal.addEventListener('abort', retire, { once: true });
    if (signal.aborted) retire();
    if (!botsResource) void refresh();
    const timer = botsResource ? null : setInterval(() => void refresh(), 30000);
    return () => {
      if (timer) clearInterval(timer);
      signal.removeEventListener('abort', retire);
      c.abort();
      life.current = null;
    };
  }, [rpc, signal, botsResource]);

  useEffect(() => {
    onStateChange?.({
      busy,
      activeBotId,
      activePresetId,
      operation,
      error: error && !editor ? error : undefined,
    });
  }, [busy, activeBotId, activePresetId, operation, error, editor, onStateChange]);

  async function openEditor(status?: PersonalAssistantStatus, retained?: Editor) {
    if (lock.current) return;
    const e = ++editorEpoch.current;
    const normalized = status ? normalizeAssistantActor(status) : null;
    const initialName = normalized
      ? formatAssistantDisplayName(normalized, personalTitle)
      : '';
    setEditor(
      retained ?? {
        status,
        name: initialName,
        duties: status?.assistant?.duties ?? '',
        environment: status?.assistant?.environment ?? { kind: 'local' },
      },
    );
    setCatalog(undefined);
    setModels(undefined);
    setModelsLoading(Boolean(status?.assistant));
    setError('');
    try {
      const s = request();
      await rpc.connect();
      const env = (await rpc.request('opencraft/personal-assistant/environments', {}, s)) ?? {
        local: true,
        templates: [],
      };
      if (s.aborted || e !== editorEpoch.current) return;
      setCatalog(env);
      if (status?.assistant) {
        const m = await rpc.request(
          'opencraft/personal-assistant/models',
          { botId: status.assistant.binding.botId },
          s,
        );
        if (!s.aborted && e === editorEpoch.current && m) setModels(m);
      }
    } catch {
      if (e === editorEpoch.current && !life.current?.signal.aborted) setError(f('failed'));
    } finally {
      if (e === editorEpoch.current && !life.current?.signal.aborted) setModelsLoading(false);
    }
  }

  function closeEditor() {
    if (lock.current) return;
    editorEpoch.current++;
    setEditor(undefined);
    setError('');
  }

  async function commitEditor() {
    if (!editor || lock.current || !editor.name.trim() || !catalog) return;
    const existing = editor.status?.assistant;
    if (existing) {
      const normalized = normalizeAssistantActor(editor.status!);
      const currentDisplay = normalized ? formatAssistantDisplayName(normalized, personalTitle) : existing.name ?? '';
      const unchanged =
        editor.name.trim() === currentDisplay.trim() &&
        editor.duties === (existing.duties ?? '') &&
        JSON.stringify(editor.environment) === JSON.stringify(existing.environment ?? { kind: 'local' });
      if (unchanged) {
        closeEditor();
        return;
      }
    }
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      const s = request();
      const body = { name: editor.name.trim(), duties: editor.duties, environment: editor.environment };
      let result: PersonalAssistantStatus;
      if (existing) {
        result = await rpc.request(
          'opencraft/personal-assistant/bots/update',
          {
            ...body,
            botId: existing.binding.botId,
            expectedRevision: existing.configRevision ?? 0,
          },
          s,
        );
      } else {
        const payload = JSON.stringify(body);
        if (creation.current?.payload !== payload) {
          creation.current = { payload, id: 'create-bot:' + createClientId() };
        }
        result = await rpc.request(
          'opencraft/personal-assistant/bots/create',
          { ...body, clientRequestId: creation.current.id },
          s,
        );
      }
      if (s.aborted) return;
      editorEpoch.current++;
      setEditor(undefined);
      creation.current = null;
      setFeedback(f('saved'));
      if (result?.assistant) commitReplicaRow(result);
      await refresh();
    } catch (e) {
      if (!life.current?.signal.aborted) {
        setError(e instanceof Error && e.message.includes('conflict') ? f('revision') : f('failed'));
      }
    } finally {
      lock.current = false;
      if (!life.current?.signal.aborted) setBusy(false);
    }
  }

  async function hirePreset(presetId: AssistantPresetId) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setActivePresetId(presetId);
    setOperation('hire');
    setError('');
    const release = botsResource?.hold();
    try {
      const s = request();
      await rpc.connect();
      presetHireKey.current[presetId] ??= `hire-preset:${presetId}:${createClientId()}`;
      let result = await rpc
        .request(
          'opencraft/personal-assistant/bots/create',
          { presetId, clientRequestId: presetHireKey.current[presetId]! },
          s,
        )
        .catch(async err => {
          if (presetId === 'personal-assistant') {
            return rpc.request('opencraft/personal-assistant/claim', {}, s);
          }
          throw err;
        });
      if (!result?.assistant && presetId === 'personal-assistant') {
        result = await rpc.request('opencraft/personal-assistant/claim', {}, s);
      }
      if (s.aborted) return;
      delete presetHireKey.current[presetId];
      release?.();
      if (result?.assistant) {
        commitReplicaRow(result);
      }
      await refresh();
      if (result?.assistant && result.runtime.phase === 'config_required') {
        lock.current = false;
        setBusy(false);
        setActivePresetId(null);
        setOperation(null);
        void openEditor(result);
        return;
      }
    } catch {
      if (!life.current?.signal.aborted) setError(f('failed'));
    } finally {
      release?.();
      lock.current = false;
      if (!life.current?.signal.aborted) {
        setBusy(false);
        setActivePresetId(null);
        setOperation(null);
      }
    }
  }

  async function operate(row: PersonalAssistantStatus, action: 'pause' | 'chat') {
    const a = row.assistant;
    if (!a || lock.current) return;
    const botId = a.binding.botId;
    lock.current = true;
    setBusy(true);
    setActiveBotId(botId);
    setOperation(action === 'chat' ? 'open' : 'pause');
    setError('');
    try {
      const s = request();
      await rpc.connect();
      if (action === 'chat') {
        const result = await rpc.request('opencraft/personal-assistant/open', { botId }, s);
        if (!s.aborted && result?.channel?.id) onOpen(result.channel.id);
      } else {
        const nextPaused = !isAssistantPaused(a);
        let result = await rpc
          .request(
            'opencraft/personal-assistant/bots/pause',
            {
              botId,
              paused: nextPaused,
              expectedRevision: a.configRevision ?? 0,
            },
            s,
          )
          .catch(async err => {
            if (a.isDefault) {
              return nextPaused
                ? rpc.request('opencraft/personal-assistant/revoke', { botId }, s)
                : rpc.request('opencraft/personal-assistant/claim', {}, s);
            }
            throw err;
          });
        if (!result?.assistant && a.isDefault) {
          result = nextPaused
            ? await rpc.request('opencraft/personal-assistant/revoke', { botId }, s)
            : await rpc.request('opencraft/personal-assistant/claim', {}, s);
        }
        if (!s.aborted) {
          if (result?.assistant) {
            commitReplicaRow(result);
            setEditor(old =>
              old?.status?.assistant?.binding.botId === botId ? { ...old, status: result } : old,
            );
          }
          await refresh();
        }
      }
    } catch {
      if (!life.current?.signal.aborted) setError(f('failed'));
    } finally {
      lock.current = false;
      if (!life.current?.signal.aborted) {
        setBusy(false);
        setActiveBotId(null);
        setOperation(null);
      }
    }
  }

  async function selectModel(value: string) {
    const a = editor?.status?.assistant;
    const m = models?.models.find(item => JSON.stringify([item.providerId, item.modelId]) === value);
    if (!a || !m || lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      const s = request();
      const result = await rpc.request(
        'opencraft/personal-assistant/model/set',
        {
          botId: a.binding.botId,
          model: { providerId: m.providerId, modelId: m.modelId },
          expectedRevision: a.modelRevision,
        },
        s,
      );
      if (!s.aborted && result?.assistant) {
        setEditor(old => (old ? { ...old, status: result } : old));
        commitReplicaRow(result);
        await refresh();
      }
    } catch {
      if (!life.current?.signal.aborted) setError(intl.formatMessage(modelMessages.modelFailed));
    } finally {
      lock.current = false;
      if (!life.current?.signal.aborted) setBusy(false);
    }
  }

  const environmentValue =
    editor?.environment.kind === 'sandbox'
      ? JSON.stringify([editor.environment.backendId, editor.environment.templateId])
      : 'local';

  const currentSelection = editor?.status?.assistant?.model
    ? JSON.stringify([editor.status.assistant.model.providerId, editor.status.assistant.model.modelId])
    : '';
  const modelSelectOptions = [
    { value: '', label: f('chooseModel') },
    ...(models?.models ?? []).map(m => ({
      value: JSON.stringify([m.providerId, m.modelId]),
      label: m.label,
    })),
  ];
  if (currentSelection && !modelSelectOptions.some(opt => opt.value === currentSelection)) {
    modelSelectOptions.splice(1, 0, {
      value: currentSelection,
      label: intl.formatMessage(modelMessages.modelUnavailable),
    });
  }
  const modelHint = models?.models.length
    ? intl.formatMessage(modelMessages.modelAbout)
    : modelsLoading
      ? f('loading')
      : models?.available === false
        ? intl.formatMessage(modelMessages.modelServiceUnavailable)
        : models
          ? intl.formatMessage(modelMessages.noModels)
          : undefined;

  if (actionsRef) {
    actionsRef.current = {
      create: () => void openEditor(),
      hirePreset: presetId => hirePreset(presetId),
      retry: () => void refresh(),
      openChat: async botId => {
        const row = rows?.find(r => r.assistant?.binding.botId === botId);
        if (row) await operate(row, 'chat');
      },
      openSettings: botId => {
        const row = rows?.find(r => r.assistant?.binding.botId === botId);
        if (row) void openEditor(row);
      },
      openMemory: botId => {
        const row = rows?.find(r => r.assistant?.binding.botId === botId);
        if (row?.assistant) setMemory(row);
      },
      togglePause: async botId => {
        const row = rows?.find(r => r.assistant?.binding.botId === botId);
        if (row) await operate(row, 'pause');
      },
    };
  }

  const memoryDisplayName = memory
    ? (() => {
        const normalized = normalizeAssistantActor(memory);
        return normalized ? formatAssistantDisplayName(normalized, personalTitle) : memory.assistant?.name ?? '';
      })()
    : '';

  const modals = (
    <>
      {editor ? (
        <Dialog.Root
          open
          onOpenChange={o => {
            if (!o) closeEditor();
          }}
        >
          <ModalContent
            className="managed-bots__dialog"
            onEscapeKeyDown={e => {
              if (busy) e.preventDefault();
            }}
            onInteractOutside={e => {
              if (busy) e.preventDefault();
            }}
          >
            <SettingsPanel
              title={
                <Dialog.Title asChild>
                  <span>{f(editor.status ? 'settings' : 'create')}</span>
                </Dialog.Title>
              }
              footer={
                <>
                  <SettingsButton disabled={busy} onClick={closeEditor}>
                    {f('cancel')}
                  </SettingsButton>
                  <SettingsButton
                    variant="primary"
                    disabled={busy || !editor.name.trim() || !catalog}
                    loading={busy}
                    onClick={() => void commitEditor()}
                  >
                    {f(editor.status ? 'save' : 'create')}
                  </SettingsButton>
                </>
              }
            >
              <Dialog.Description>{f('privacy')}</Dialog.Description>
              {editor.status ? <p className="managed-bots__hint">{f('settingsImpact')}</p> : null}
              <SettingsGroup>
                <SettingsRow layout="stacked" controlWidth="wide" label={f('name')}>
                  <SettingsTextInput
                    aria-label={f('name')}
                    value={editor.name}
                    maxLength={80}
                    disabled={busy}
                    onChange={e => setEditor({ ...editor, name: e.currentTarget.value })}
                  />
                </SettingsRow>
                <SettingsRow layout="stacked" controlWidth="wide" label={f('duties')}>
                  <SettingsTextInput
                    aria-label={f('duties')}
                    value={editor.duties}
                    maxLength={2000}
                    disabled={busy}
                    onChange={e => setEditor({ ...editor, duties: e.currentTarget.value })}
                  />
                </SettingsRow>
                <SettingsRow
                  layout="stacked"
                  controlWidth="wide"
                  label={f('environment')}
                  description={f(editor.environment.kind === 'sandbox' ? 'sandboxHint' : 'localHint')}
                >
                  <SettingsChoiceSelect
                    label={f('environment')}
                    value={environmentValue}
                    disabled={busy || !catalog}
                    options={[
                      { value: 'local', label: f('local') },
                      ...(catalog?.templates ?? []).map(t => ({
                        value: JSON.stringify([t.backendId, t.id]),
                        label:
                          (t.backendId.startsWith('e2b-') ? 'E2B' : t.backendId.toLocaleUpperCase()) +
                          ' · ' +
                          t.name,
                      })),
                    ]}
                    onValueChange={v =>
                      setEditor({
                        ...editor,
                        environment:
                          v === 'local'
                            ? { kind: 'local' }
                            : { kind: 'sandbox', backendId: JSON.parse(v)[0], templateId: JSON.parse(v)[1] },
                      })
                    }
                  />
                </SettingsRow>
                {editor.status?.assistant ? (
                  <SettingsRow layout="stacked" controlWidth="wide" label={f('model')} description={modelHint}>
                    <SettingsChoiceSelect
                      label={f('model')}
                      value={currentSelection}
                      disabled={busy || !models?.available || !models.models.length}
                      options={modelSelectOptions}
                      onValueChange={v => void selectModel(v)}
                    />
                  </SettingsRow>
                ) : null}
              </SettingsGroup>
              {catalog && !catalog.templates.length ? (
                <p className="managed-bots__hint">{f('e2bUnavailable')}</p>
              ) : null}
              {editor.status?.assistant ? (
                <AssistantThreadSettings
                  rpc={rpc}
                  botId={editor.status.assistant.binding.botId}
                  reportError={() => setError(f('failed'))}
                />
              ) : null}
              {editor.status?.assistant ? (
                <div className="managed-bots__actions">
                  <SettingsButton disabled={busy} onClick={() => setMemory(editor.status)}>
                    {f('memory')}
                  </SettingsButton>
                  <SettingsButton
                    variant="quiet"
                    disabled={busy}
                    onClick={() => void operate(editor.status!, 'pause')}
                  >
                    {f(isAssistantPaused(editor.status.assistant) ? 'resume' : 'pause')}
                  </SettingsButton>
                </div>
              ) : null}
              {error ? (
                <p role="alert">
                  {error}{' '}
                  <SettingsButton disabled={busy} onClick={() => void openEditor(editor.status, editor)}>
                    {f('retry')}
                  </SettingsButton>
                </p>
              ) : null}
            </SettingsPanel>
          </ModalContent>
        </Dialog.Root>
      ) : null}
      {memory?.assistant ? (
        <Dialog.Root
          open
          onOpenChange={o => {
            if (!o && (!memoryGuard.current || memoryGuard.current())) setMemory(undefined);
          }}
        >
          <ModalContent className="managed-bots__memory">
            <Dialog.Title>
              {memoryDisplayName} · {f('memory')}
            </Dialog.Title>
            <Dialog.Description>{f('privacy')}</Dialog.Description>
            <AssistantMemory
              rpc={rpc}
              binding={memory.assistant.binding}
              registerCloseGuard={g => {
                memoryGuard.current = g;
                return () => {
                  if (memoryGuard.current === g) memoryGuard.current = null;
                };
              }}
            />
            <SettingsButton
              onClick={() => {
                if (!memoryGuard.current || memoryGuard.current()) setMemory(undefined);
              }}
            >
              {f('close')}
            </SettingsButton>
          </ModalContent>
        </Dialog.Root>
      ) : null}
    </>
  );

  if (actionsRef) {
    return modals;
  }

  return (
    <SettingsSection title={f('title')}>
      <div className="managed-bots">
        <p className="managed-bots__hint">{f('privacy')}</p>
        <div>
          <SettingsButton variant="primary" disabled={busy || !rows || failed} onClick={() => void openEditor()}>
            {f('create')}
          </SettingsButton>
        </div>
        {!rows && !failed ? <p role="status">{f('loading')}</p> : null}
        {failed ? (
          <p role="status">
            {f('failed')}{' '}
            <SettingsButton disabled={busy} onClick={() => void refresh()}>
              {f('retry')}
            </SettingsButton>
          </p>
        ) : null}
        {rows?.map(row => {
          const normalized = normalizeAssistantActor(row);
          if (!normalized) return null;
          const displayName = formatAssistantDisplayName(normalized, personalTitle);
          const envLabel = normalized.paused
            ? f('paused')
            : formatEnvironmentLabel(normalized.environment, f('local'));
          return (
            <div key={normalized.botId} className="managed-bots__row">
              <CompanionAvatar id={normalized.actorId} />
              <div className="managed-bots__copy">
                <strong>{displayName}</strong>
                <small>
                  {envLabel} · {normalized.model?.modelId ?? f('noModel')}
                </small>
                {normalized.duties ? <p>{normalized.duties}</p> : null}
              </div>
              <div className="managed-bots__actions">
                <SettingsButton disabled={busy} onClick={() => void operate(row, 'chat')}>
                  {f('chat')}
                </SettingsButton>
                <SettingsButton disabled={busy} onClick={() => void openEditor(row)}>
                  {f('settings')}
                </SettingsButton>
                <SettingsButton variant="quiet" disabled={busy} onClick={() => void operate(row, 'pause')}>
                  {f(normalized.paused ? 'resume' : 'pause')}
                </SettingsButton>
              </div>
            </div>
          );
        })}
        {rows?.length === 0 ? <p className="managed-bots__hint">{f('empty')}</p> : null}
        <span role="status">{feedback}</span>
        {error && !editor ? <p role="alert">{error}</p> : null}
        {modals}
      </div>
    </SettingsSection>
  );
}
