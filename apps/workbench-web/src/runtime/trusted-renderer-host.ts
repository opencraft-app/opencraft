import * as React from 'react';
import {TASKS, TASK_STATUSES, TASK_PRIORITIES, TASK_KINDS, TASK_AI_RESEARCH} from '@opencraft/appserver-protocol';
import * as jsx from 'react/jsx-runtime';
import { createDeferredView, SettingsActions, SettingsButton, SettingsGroup, SettingsNotice, SettingsPanel, SegmentedControl, SettingsSelect, SettingsTextInput, SettingsControlPair, SettingsChoiceSelect, SettingsCopyButton, AvatarImage, IdentityAvatarContext } from '@opencraft/extension-react';
import {Button, IconButton, ObjectTitleButton, ObjectActionSurface} from '@opencraft/design-system-web/button';
import * as modalContent from '@opencraft/design-system-web/modal-content';
import * as dropdownMenu from '@opencraft/design-system-web/dropdown-menu';
import * as dialog from '@radix-ui/react-dialog';
import * as popover from '@radix-ui/react-popover';
import * as reactIntl from 'react-intl';
import { useIntl } from '@opencraft/i18n/react';
import * as actionIcons from '@opencraft/design-system-web/action-icons';
import { combineAbortSignals } from '@opencraft/appserver-client/transport';
import type { AppServerClient } from '@opencraft/appserver-client';
import { legacyDirectServerProjectionFromHost } from '@opencraft/workbench-runtime';
import type { TrustedExtensionDefinition } from '@opencraft/extension-runtime';
import { serverUrl } from './server-context';

/** Explicit versioned bridge for administrator-approved native renderer data.
 * No second React/context runtime, global module registry, or arbitrary import map.
 * This is trusted renderer code, NOT a sandbox or a public craft capability. */
export async function loadTrustedRenderer(value: unknown, configuration: Readonly<Record<string, unknown>>,
  getClient: (hostId: string) => AppServerClient | undefined = () => undefined, tasks?: () => import("@opencraft/plugin-tasks").TasksExtensionPorts): Promise<TrustedExtensionDefinition> {
  const pack = value as { hostApi?: unknown; css?: unknown; create?: unknown } | null;
  if (pack?.hostApi !== 'trusted-react-v1' || typeof pack.create !== 'function'
    || (pack.css !== undefined && (typeof pack.css !== 'string' || pack.css.length > 256 * 1024))) throw new Error('Unsupported trusted renderer package');
  const modules = Object.freeze({
    react: React, 'react/jsx-runtime': jsx,
    '@opencraft/appserver-protocol': Object.freeze({TASKS, TASK_STATUSES, TASK_PRIORITIES, TASK_KINDS, TASK_AI_RESEARCH}),
    '@opencraft/extension-react': Object.freeze({createDeferredView, SettingsActions, SettingsButton, SettingsGroup, SettingsNotice, SettingsPanel, SegmentedControl, SettingsSelect, SettingsTextInput, SettingsControlPair, SettingsChoiceSelect, SettingsCopyButton, AvatarImage, IdentityAvatarContext}),
    '@opencraft/design-system-web/button': Object.freeze({Button, IconButton, ObjectTitleButton, ObjectActionSurface}),
    '@opencraft/design-system-web/modal-content': modalContent,
    '@opencraft/design-system-web/dropdown-menu': dropdownMenu,
    '@radix-ui/react-dialog': dialog, '@radix-ui/react-popover': popover,
    'react-intl': reactIntl, '@opencraft/i18n/react': Object.freeze({ useIntl }),
    '@opencraft/design-system-web/action-icons': actionIcons,
    '@opencraft/appserver-client/transport': Object.freeze({ combineAbortSignals }),
    '@opencraft/workbench-runtime': Object.freeze({ legacyDirectServerProjectionFromHost }),
  });
  const definition = await pack.create(Object.freeze({ hostApi:'trusted-react-v1', modules, configuration:structuredClone(configuration),
    services:Object.freeze({ ...(tasks ? { tasks: tasks() } : {}) }),
    fetcher:(url: string, init?: RequestInit) => fetch(serverUrl(url), init), getClient }));
  if (!definition || typeof definition.activate !== 'function') throw new Error('Invalid trusted renderer definition');
  return { ...definition, async activate(api) {
    api.signal.throwIfAborted();
    let style: HTMLStyleElement | undefined;
    const releaseStyle = () => { style?.remove(); api.signal.removeEventListener('abort', releaseStyle); };
    if (pack.css) { style = document.createElement('style'); style.textContent = pack.css as string; document.head.appendChild(style); }
    api.signal.addEventListener('abort', releaseStyle, { once:true });
    try {
      const dispose = await definition.activate(api);
      return async () => { try { await dispose?.(); } finally { releaseStyle(); } };
    } catch (error) { releaseStyle(); throw error; }
  } };
}
