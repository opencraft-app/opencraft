import { describe, expect, it } from 'vitest';
import type { ChatMessage } from './acpClient';
import { getMessageSections, getToolGroupSummary } from './messagePresentation';

const baseMessage: ChatMessage = {
  id: 'message-1',
  conversationId: 'conv-1',
  role: 'agent',
  sender: '主AGENTS',
  time: '12:00',
  content: '',
};

describe('message presentation sections', () => {
  it('renders visible answer content before reasoning and tools', () => {
    const sections = getMessageSections({
      ...baseMessage,
      thought: 'think first',
      content: 'answer second',
      toolCalls: [{ id: 'tool-1', name: 'read', status: 'done' }],
    });

    expect(sections.map((section) => section.type)).toEqual(['content', 'thought', 'tools']);
  });

  it('does not create a blank body section for whitespace-only content', () => {
    const sections = getMessageSections({
      ...baseMessage,
      thought: 'only reasoning',
      content: '   \n',
    });

    expect(sections).toEqual([{ type: 'thought', text: 'only reasoning' }]);
  });

  it('keeps attachments below text and above tool strips', () => {
    const sections = getMessageSections({
      ...baseMessage,
      content: 'see attached',
      attachments: [{ id: 'a1', name: 'note.md', type: 'text/markdown', size: 12 }],
      toolCalls: [{ id: 'tool-1', name: 'read', status: 'running' }],
    });

    expect(sections.map((section) => section.type)).toEqual(['content', 'attachments', 'tools']);
  });

  it('preserves timeline block order when available', () => {
    const sections = getMessageSections({
      ...baseMessage,
      content: 'final answer',
      thought: 'thinking',
      toolCalls: [{ id: 'tool-1', name: 'web_search', status: 'done' }],
      timelineBlocks: [
        { id: 'thought-1', type: 'thought', text: 'thinking' },
        {
          id: 'tools-1',
          type: 'tools',
          toolCalls: [{ id: 'tool-1', name: 'web_search', status: 'done' }],
        },
        { id: 'content-1', type: 'content', text: 'final answer' },
      ],
    });

    expect(sections.map((section) => section.type)).toEqual(['thought', 'tools', 'content']);
    expect(sections.map((section) => section.id)).toEqual(['thought-1', 'tools-1', 'content-1']);
  });

  it('summarizes mixed tool groups for collapsed display', () => {
    expect(getToolGroupSummary([
      { id: 'search-1', name: 'web_search', status: 'done', kind: 'search' },
      { id: 'cmd-1', name: 'terminal', status: 'done', kind: 'execute' },
      { id: 'cmd-2', name: 'code_execution', status: 'error', kind: 'execute' },
    ])).toBe('已搜索 1 次 · 已运行 2 条命令 · 1 个失败');
  });
});
