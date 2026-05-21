import { describe, expect, it } from 'vitest';
import { buildPromptContent, canSendPrompt, chooseModeWritePath, chooseModelWritePath, decideReopen, normalizeAttachmentRelativePath, validateAttachment } from './protocol';

describe('control path decisions', () => {
  it('uses configOptions for model before set_model fallback', () => {
    const decision = chooseModelWritePath({
      configOptions: [{ id: 'model', category: 'model', type: 'select', currentValue: 'a', options: [] }],
      setModelExplicitlyExposed: true,
      setModelProvenLive: true,
    });
    expect(decision.path).toBe('set_config_option');
  });

  it('falls back to set_mode only when no usable mode option exists', () => {
    const decision = chooseModeWritePath({
      configOptions: [{ id: 'thought', category: 'thought_level', type: 'select', currentValue: 'low' }],
      legacyModesExposed: true,
    });
    expect(decision.path).toBe('set_mode');
  });
});

describe('reopen decisions', () => {
  it('loads listed historical sessions instead of resuming when replay is required', () => {
    expect(decideReopen({
      liveConnection: false,
      listedByAgent: true,
      listSupported: true,
      loadSupported: true,
      hasSessionId: true,
      hasCwd: true,
      mcpServersAuthoritative: true,
      requiredRootsAuthoritative: true,
    })).toMatchObject({ action: 'load', replay: true });
  });

  it('blocks stored sessions when session/list is unavailable', () => {
    expect(decideReopen({
      liveConnection: false,
      listedByAgent: false,
      listSupported: false,
      loadSupported: true,
      hasSessionId: true,
      hasCwd: true,
      mcpServersAuthoritative: true,
      requiredRootsAuthoritative: true,
    })).toMatchObject({ action: 'blocked', errorKind: 'session_list_unavailable' });
  });

  it('blocks stored sessions that are absent from the ACP list', () => {
    expect(decideReopen({
      liveConnection: false,
      listedByAgent: false,
      listSupported: true,
      loadSupported: true,
      hasSessionId: true,
      hasCwd: true,
      mcpServersAuthoritative: true,
      requiredRootsAuthoritative: true,
    })).toMatchObject({ action: 'blocked', errorKind: 'resume_rejected' });
  });

  it('blocks load without mcpServers', () => {
    expect(decideReopen({
      liveConnection: false,
      listedByAgent: true,
      listSupported: true,
      loadSupported: true,
      hasSessionId: true,
      hasCwd: true,
      mcpServersAuthoritative: false,
      requiredRootsAuthoritative: true,
    })).toMatchObject({ action: 'blocked', errorKind: 'load_inputs_missing' });
  });

  it('does not silently create a new session when a stored session cannot be restored', () => {
    expect(decideReopen({
      liveConnection: false,
      listedByAgent: true,
      listSupported: true,
      loadSupported: false,
      hasSessionId: true,
      hasCwd: true,
      mcpServersAuthoritative: true,
      requiredRootsAuthoritative: true,
    })).toMatchObject({ action: 'blocked', errorKind: 'resume_rejected' });
  });

  it('creates a new session only when there is no stored session to preserve', () => {
    expect(decideReopen({
      liveConnection: false,
      listedByAgent: false,
      listSupported: false,
      loadSupported: false,
      hasSessionId: false,
      hasCwd: true,
      mcpServersAuthoritative: true,
      requiredRootsAuthoritative: true,
    })).toMatchObject({ action: 'new', replay: false });
  });
});

describe('attachment validation', () => {
  it('accepts image storage attachments without inline image capability', () => {
    expect(validateAttachment({ name: 'x.png', type: 'image/png', size: 100 }, false)).toMatchObject({
      ok: true,
      category: 'image',
    });
  });

  it('accepts text attachment', () => {
    expect(validateAttachment({ name: 'notes.md', type: 'text/markdown', size: 100 }, false)).toMatchObject({
      ok: true,
      category: 'text',
    });
  });

  it('rejects oversize attachments', () => {
    expect(validateAttachment({ name: 'huge.md', type: 'text/markdown', size: 9 * 1024 * 1024 }, false)).toMatchObject({
      ok: false,
      kind: 'attachment_type_unavailable',
    });
  });

  it('accepts image attachment when image capability is advertised', () => {
    expect(validateAttachment({ name: 'x.png', type: 'image/png', size: 100 }, true)).toMatchObject({
      ok: true,
      category: 'image',
    });
  });
});

describe('prompt construction and send eligibility', () => {
  it('uses URI-only wrapper resources for uploaded attachments without embeddedContext', () => {
    const result = buildPromptContent({
      text: 'read this',
      files: [{
        name: 'notes.md',
        type: 'text/markdown',
        size: 12,
        data: '# hi',
        uploaded: {
          fileId: 'file_123',
          name: 'notes.md',
          mimeType: 'text/markdown',
          size: 12,
          downloadUrl: '/v1/files/file_123/content',
          relativePath: 'docs/notes.md',
        },
      }],
      capabilities: {},
    });
    expect(result.ok).toBe(true);
    expect(result.prompt).toEqual([
      { type: 'text', text: 'read this' },
      {
        type: 'resource',
        resource: {
          uri: 'wrapper-file://file_123',
          mimeType: 'text/markdown',
          name: 'notes.md',
          size: 12,
          relativePath: 'docs/notes.md',
        },
      },
    ]);
    expect(result.displayAttachments[0]).toMatchObject({
      id: 'file_123',
      fileId: 'file_123',
      downloadUrl: '/v1/files/file_123/content',
      relativePath: 'docs/notes.md',
    });
  });

  it('rejects attachments that were not uploaded instead of degrading them into text', () => {
    const result = buildPromptContent({
      text: 'read this',
      files: [{ name: 'notes.md', type: 'text/markdown', size: 12, data: '# hi' }],
      capabilities: {},
    });
    expect(result).toMatchObject({
      ok: false,
      prompt: [],
      displayAttachments: [],
      error: { code: 'unsupported', kind: 'attachment_type_unavailable' },
    });
  });

  it('does not embed local file bodies even when embeddedContext is advertised', () => {
    const result = buildPromptContent({
      text: '',
      files: [{ name: 'notes.md', type: 'text/markdown', size: 12, data: '# hi' }],
      capabilities: { embeddedContext: true },
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'unsupported', kind: 'attachment_type_unavailable' },
    });
  });

  it('rejects mixed attachments predictably when any file is unsupported', () => {
    const result = buildPromptContent({
      text: 'read this',
      files: [
        { name: 'notes.md', type: 'text/markdown', size: 12, data: '# hi' },
        { name: 'archive.zip', type: 'application/zip', size: 12, data: 'zip' },
      ],
      capabilities: {},
    });

    expect(result).toMatchObject({
      ok: false,
      prompt: [],
      displayAttachments: [],
      error: { code: 'unsupported', kind: 'attachment_type_unavailable' },
    });
  });

  it('normalizes directory upload relative paths and rejects traversal', () => {
    expect(normalizeAttachmentRelativePath('docs/nested/TODO.md')).toEqual({
      ok: true,
      path: 'docs/nested/TODO.md',
    });
    expect(normalizeAttachmentRelativePath('../TODO.md')).toEqual({ ok: false });
    expect(normalizeAttachmentRelativePath('/tmp/TODO.md')).toEqual({ ok: false });
    expect(normalizeAttachmentRelativePath('docs//TODO.md')).toEqual({ ok: false });
  });

  it('allows supported attachment-only sends while blocking empty sends', () => {
    expect(canSendPrompt({
      text: '',
      attachments: [{ name: 'notes.md', type: 'text/markdown', size: 12 }],
      status: 'connected',
      restoreState: 'live',
      pending: false,
      imageCapability: false,
    })).toBe(true);
    expect(canSendPrompt({
      text: '',
      attachments: [],
      status: 'connected',
      restoreState: 'live',
      pending: false,
      imageCapability: false,
    })).toBe(false);
  });

  it('blocks sends while pending or restore-blocked', () => {
    expect(canSendPrompt({
      text: 'hello',
      attachments: [],
      status: 'connected',
      restoreState: 'blocked',
      pending: false,
      imageCapability: false,
    })).toBe(false);
    expect(canSendPrompt({
      text: 'hello',
      attachments: [],
      status: 'connected',
      restoreState: 'live',
      pending: true,
      imageCapability: false,
    })).toBe(false);
    expect(canSendPrompt({
      text: 'hello',
      attachments: [],
      status: 'connected',
      restoreState: 'restoring',
      pending: false,
      imageCapability: false,
    })).toBe(false);
  });
});

describe('live-path contract examples', () => {
  it('documents raw ACP stderr isolation and session-backed conversations through stable helpers', () => {
    const model = chooseModelWritePath({
      configOptions: [{ id: 'primary-model', category: 'model', type: 'select', currentValue: 'a', options: [{ value: 'b' }] }],
      setModelExplicitlyExposed: true,
      setModelProvenLive: true,
    });
    const reopened = decideReopen({
      liveConnection: true,
      listedByAgent: false,
      listSupported: false,
      loadSupported: false,
      hasSessionId: true,
      hasCwd: true,
      mcpServersAuthoritative: false,
      requiredRootsAuthoritative: true,
    });
    expect(model).toMatchObject({ path: 'set_config_option', configId: 'primary-model' });
    expect(reopened).toMatchObject({ action: 'rebind', replay: false });
  });
});
