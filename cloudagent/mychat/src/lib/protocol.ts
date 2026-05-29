export type AppErrorCode =
  | 'busy'
  | 'unsupported'
  | 'restore_failed'
  | 'provider_rejected'
  | 'security';

export type AppErrorKind =
  | 'active_turn_in_progress'
  | 'control_path_unavailable'
  | 'attachment_type_unavailable'
  | 'attachment_upload_failed'
  | 'resume_rejected'
  | 'session_read_only'
  | 'session_list_unavailable'
  | 'load_inputs_missing'
  | 'additional_roots_missing'
  | 'multimodal_rejected'
  | 'provider_error'
  | 'token_required';

export interface ConfigOption {
  id: string;
  name?: string;
  category?: string;
  type: 'select' | string;
  currentValue: string;
  options?: { value: string; name?: string; description?: string }[];
}

export interface PromptCapabilities {
  image?: boolean;
  audio?: boolean;
  embeddedContext?: boolean;
}

export interface UploadedAttachment {
  fileId: string;
  name: string;
  mimeType: string;
  size: number;
  downloadUrl: string;
  relativePath?: string;
}

export interface PromptAttachment {
  name: string;
  type: string;
  size: number;
  data?: string;
  file?: Blob;
  relativePath?: string;
  uploaded?: UploadedAttachment;
}

export interface PromptDisplayAttachment extends PromptAttachment {
  id: string;
  url?: string;
  fileId?: string;
  downloadUrl?: string;
  relativePath?: string;
}

export type PromptContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; data: string }
  | {
      type: 'resource';
      resource: {
        uri: string;
        mimeType?: string;
        name?: string;
        size?: number;
        relativePath?: string;
        text?: string;
      };
    };

export interface PromptBuildResult {
  ok: boolean;
  prompt: PromptContentBlock[];
  displayAttachments: PromptDisplayAttachment[];
  error?: { code: AppErrorCode; kind: AppErrorKind; message?: string };
}

export interface ControlDecision {
  path: 'set_config_option' | 'set_model' | 'set_mode' | 'read_only';
  configId?: string;
  reason: string;
}

export function chooseModelWritePath(input: {
  configOptions?: ConfigOption[] | null;
  setModelExplicitlyExposed?: boolean;
  setModelProvenLive?: boolean;
}): ControlDecision {
  const option = input.configOptions?.find((item) => isModelOption(item));
  if (option) {
    return { path: 'set_config_option', configId: option.id, reason: 'model config option exposed' };
  }
  if (input.setModelExplicitlyExposed && input.setModelProvenLive) {
    return { path: 'set_model', reason: 'set_model fallback explicitly proven live' };
  }
  return { path: 'read_only', reason: 'no supported model write path' };
}

export function chooseModeWritePath(input: {
  configOptions?: ConfigOption[] | null;
  legacyModesExposed?: boolean;
}): ControlDecision {
  const option = input.configOptions?.find((item) => isModeOption(item));
  if (option) {
    return { path: 'set_config_option', configId: option.id, reason: 'mode config option exposed' };
  }
  if (input.legacyModesExposed) {
    return { path: 'set_mode', reason: 'legacy set_mode fallback only because no usable mode config option exists' };
  }
  return { path: 'read_only', reason: 'no supported mode write path' };
}

function isModelOption(option: ConfigOption) {
  const text = `${option.id} ${option.name ?? ''} ${option.category ?? ''}`.toLowerCase();
  return option.category === 'model' || /\bmodel\b/.test(text);
}

function isModeOption(option: ConfigOption) {
  const text = `${option.id} ${option.name ?? ''} ${option.category ?? ''}`.toLowerCase();
  return option.category === 'mode' || /\bmode\b/.test(text);
}

export interface ReopenInput {
  liveConnection: boolean;
  transcriptLoaded?: boolean;
  listedByAgent: boolean;
  listSupported: boolean;
  loadSupported: boolean;
  hasSessionId: boolean;
  hasCwd: boolean;
  mcpServersAuthoritative: boolean;
  requiredRootsAuthoritative: boolean;
}

export interface ReopenDecision {
  action: 'rebind' | 'load' | 'blocked' | 'new';
  replay: boolean;
  errorKind?: AppErrorKind;
}

export function decideReopen(input: ReopenInput): ReopenDecision {
  if (!input.requiredRootsAuthoritative) {
    return { action: 'blocked', replay: false, errorKind: 'additional_roots_missing' };
  }
  if (input.liveConnection && input.hasSessionId && input.transcriptLoaded) {
    return { action: 'rebind', replay: false };
  }
  if (input.hasSessionId && !input.listSupported) {
    return { action: 'blocked', replay: false, errorKind: 'session_list_unavailable' };
  }
  if (input.hasSessionId && input.listSupported && !input.listedByAgent) {
    return { action: 'blocked', replay: false, errorKind: 'resume_rejected' };
  }
  if (input.loadSupported && input.hasSessionId && input.hasCwd && input.mcpServersAuthoritative) {
    return { action: 'load', replay: true };
  }
  if (input.loadSupported && input.hasSessionId && input.hasCwd && !input.mcpServersAuthoritative) {
    return { action: 'blocked', replay: false, errorKind: 'load_inputs_missing' };
  }
  if (input.hasSessionId) {
    return { action: 'blocked', replay: false, errorKind: 'resume_rejected' };
  }
  return { action: 'new', replay: false };
}

export interface AttachmentCandidate {
  name: string;
  type: string;
  size: number;
  relativePath?: string;
}

export function validateAttachment(file: AttachmentCandidate, _imageCapability: boolean, maxBytes = 8 * 1024 * 1024) {
  if (file.size > maxBytes) {
    return { ok: false as const, code: 'unsupported' as const, kind: 'attachment_type_unavailable' as const };
  }
  if (file.relativePath !== undefined) {
    const normalized = normalizeAttachmentRelativePath(file.relativePath);
    if (!normalized.ok) {
      return { ok: false as const, code: 'unsupported' as const, kind: 'attachment_type_unavailable' as const };
    }
  }
  if (file.type.startsWith('image/')) {
    return { ok: true as const, category: 'image' as const };
  }
  if (file.type.startsWith('text/') || file.name.endsWith('.md') || file.name.endsWith('.json')) {
    return { ok: true as const, category: 'text' as const };
  }
  return { ok: true as const, category: 'file' as const };
}

export function canSendPrompt(input: {
  text: string;
  attachments: AttachmentCandidate[];
  status: 'connecting' | 'connected' | 'disconnected' | 'error';
  restoreState: 'new' | 'restoring' | 'live' | 'blocked' | 'error';
  pending: boolean;
  imageCapability: boolean;
}) {
  if (
    input.status !== 'connected' ||
    input.pending ||
    input.restoreState === 'restoring' ||
    input.restoreState === 'blocked' ||
    input.restoreState === 'error'
  ) {
    return false;
  }
  if (input.text.trim().length > 0) return true;
  return input.attachments.some((attachment) => validateAttachment(attachment, input.imageCapability).ok);
}

export function buildPromptContent(input: {
  text: string;
  files: PromptAttachment[];
  capabilities: PromptCapabilities;
}): PromptBuildResult {
  const prompt: PromptContentBlock[] = [];
  const displayAttachments: PromptDisplayAttachment[] = [];
  const text = input.text.trim();
  if (text) {
    prompt.push({ type: 'text', text });
  }

  for (const file of input.files) {
    const validation = validateAttachment(file, input.capabilities.image === true);
    if (!validation.ok) {
      return {
        ok: false,
        prompt: [],
        displayAttachments: [],
        error: { code: validation.code, kind: validation.kind },
      };
    }

    displayAttachments.push({
      id: file.uploaded?.fileId ?? `${file.name}:${file.size}:${displayAttachments.length}`,
      name: file.uploaded?.name ?? file.name,
      type: file.uploaded?.mimeType ?? file.type,
      size: file.uploaded?.size ?? file.size,
      data: file.data,
      url: file.uploaded?.downloadUrl ?? (file.type.startsWith('image/') ? file.data : undefined),
      fileId: file.uploaded?.fileId,
      downloadUrl: file.uploaded?.downloadUrl,
      relativePath: file.uploaded?.relativePath ?? file.relativePath,
    });

    if (!file.uploaded) {
      return {
        ok: false,
        prompt: [],
        displayAttachments: [],
        error: {
          code: 'unsupported',
          kind: 'attachment_type_unavailable',
          message: 'Attachment must be uploaded before it can be sent',
        },
      };
    }

    prompt.push({
      type: 'resource',
      resource: {
        uri: `wrapper-file://${file.uploaded.fileId}`,
        mimeType: file.uploaded.mimeType || 'application/octet-stream',
        name: file.uploaded.name,
        size: file.uploaded.size,
        relativePath: file.uploaded.relativePath,
      },
    });
  }

  if (prompt.length === 0) {
    return {
      ok: false,
      prompt,
      displayAttachments,
      error: { code: 'unsupported', kind: 'attachment_type_unavailable', message: 'No text or supported attachments to send' },
    };
  }

  return { ok: true, prompt, displayAttachments };
}

export function normalizeAttachmentRelativePath(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return { ok: false as const };
  if (trimmed.startsWith('/') || /^[A-Za-z]:[\\/]/.test(trimmed)) {
    return { ok: false as const };
  }
  const parts = trimmed.split(/[\\/]/);
  if (
    parts.some(
      (part) =>
        !part ||
        part === '.' ||
        part === '..' ||
        hasControlCharacter(part),
    )
  ) {
    return { ok: false as const };
  }
  return { ok: true as const, path: parts.join('/') };
}

function hasControlCharacter(value: string) {
  return Array.from(value).some((char) => {
    const code = char.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

export function stripDataURLPrefix(value: string) {
  const marker = ';base64,';
  const index = value.indexOf(marker);
  return index === -1 ? value : value.slice(index + marker.length);
}
