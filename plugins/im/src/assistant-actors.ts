import {
  BUILTIN_ASSISTANT_PRESETS,
  type AssistantCardinality,
  type AssistantPreset,
  type AssistantPresetId,
  type BotEnvironment,
  type PersonalAssistant,
  type PersonalAssistantRuntimeState,
  type PersonalAssistantStatus,
} from '@opencraft/appserver-protocol';

export interface NormalizedAssistantActor {
  readonly botId: string;
  readonly actorId: string;
  readonly assignmentId: string;
  readonly presetId: AssistantPresetId | null;
  readonly cardinality: AssistantCardinality;
  readonly isSingletonPreset: boolean;
  readonly rawName: string;
  readonly duties: string;
  readonly environment: BotEnvironment;
  readonly paused: boolean;
  readonly phase: PersonalAssistantRuntimeState['phase'];
  readonly configRevision: number;
  readonly modelRevision: number;
  readonly model: PersonalAssistant['model'];
  readonly channelId: string | null;
  readonly status: PersonalAssistantStatus;
}

export function resolveAssistantPresetId(assistant: PersonalAssistant): AssistantPresetId | null {
  if (assistant.presetId) return assistant.presetId;
  return assistant.isDefault ? 'personal-assistant' : null;
}

export function resolveAssistantCardinality(assistant: PersonalAssistant): AssistantCardinality {
  if (assistant.cardinality) return assistant.cardinality;
  return resolveAssistantPresetId(assistant) === 'personal-assistant' ? 'singleton-per-human' : 'multi';
}

export function isAssistantPaused(assistant: PersonalAssistant): boolean {
  return Boolean(assistant.paused) || assistant.state !== 'claimed';
}

export function normalizeAssistantActor(status: PersonalAssistantStatus): NormalizedAssistantActor | null {
  const assistant = status.assistant;
  if (!assistant) return null;
  const presetId = resolveAssistantPresetId(assistant);
  const cardinality = resolveAssistantCardinality(assistant);
  const paused = isAssistantPaused(assistant);
  const phase: PersonalAssistantRuntimeState['phase'] = paused ? 'stopped' : status.runtime.phase;
  return {
    botId: assistant.binding.botId,
    actorId: assistant.actorId,
    assignmentId: assistant.binding.assignmentId,
    presetId,
    cardinality,
    isSingletonPreset: cardinality === 'singleton-per-human',
    rawName: assistant.name ?? '',
    duties: assistant.duties ?? '',
    environment: assistant.environment ?? { kind: 'local' },
    paused,
    phase,
    configRevision: assistant.configRevision ?? 0,
    modelRevision: assistant.modelRevision,
    model: assistant.model,
    channelId: status.channelId ?? null,
    status,
  };
}

export function normalizeAssistantActorList(rows: readonly PersonalAssistantStatus[]): NormalizedAssistantActor[] {
  const normalized: NormalizedAssistantActor[] = [];
  for (const row of rows) {
    const actor = normalizeAssistantActor(row);
    if (actor) normalized.push(actor);
  }
  normalized.sort((a, b) => {
    if (a.isSingletonPreset !== b.isSingletonPreset) return a.isSingletonPreset ? -1 : 1;
    const createdDiff = (a.status.assistant?.createdAt ?? 0) - (b.status.assistant?.createdAt ?? 0);
    if (createdDiff !== 0) return createdDiff;
    return a.botId.localeCompare(b.botId);
  });
  return normalized;
}

export function projectAvailableAssistantPresets(
  rows: readonly PersonalAssistantStatus[],
  presets: readonly AssistantPreset[] = BUILTIN_ASSISTANT_PRESETS,
): AssistantPreset[] {
  const hiredPresetIds = new Set<AssistantPresetId>();
  for (const row of rows) {
    if (!row.assistant) continue;
    const presetId = resolveAssistantPresetId(row.assistant);
    if (presetId) hiredPresetIds.add(presetId);
  }
  return presets.filter(preset => preset.cardinality !== 'singleton-per-human' || !hiredPresetIds.has(preset.id));
}

export function upsertAssistantStatusList(
  current: readonly PersonalAssistantStatus[] | undefined,
  updated: PersonalAssistantStatus,
): PersonalAssistantStatus[] {
  if (!updated.assistant) return [...(current ?? [])];
  const targetBotId = updated.assistant.binding.botId;
  const next = (current ?? []).filter(item => item.assistant && item.assistant.binding.botId !== targetBotId);
  next.push(updated);
  return normalizeAssistantActorList(next).map(actor => actor.status);
}

export function formatAssistantDisplayName(actor: NormalizedAssistantActor, localizedPersonalTitle: string): string {
  const trimmed = actor.rawName.trim();
  if (actor.presetId === 'personal-assistant' && (!trimmed || trimmed === 'Personal assistant')) {
    return localizedPersonalTitle;
  }
  return trimmed || actor.actorId;
}

export function formatEnvironmentLabel(environment: BotEnvironment, localLabel: string): string {
  if (environment.kind === 'local') return localLabel;
  const backendLabel = environment.backendId.startsWith('e2b-')
    ? 'E2B'
    : environment.backendId.toLocaleUpperCase();
  return `${backendLabel} · ${environment.templateId}`;
}
