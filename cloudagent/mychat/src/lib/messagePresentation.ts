import type { ChatMessage, ToolCall } from './acpClient';

export type MessageSection =
  | { id?: string; type: 'thought'; text: string }
  | { id?: string; type: 'content'; text: string }
  | { id?: string; type: 'attachments'; attachments: NonNullable<ChatMessage['attachments']> }
  | { id?: string; type: 'tools'; toolCalls: NonNullable<ChatMessage['toolCalls']> };

export function getMessageSections(message: ChatMessage): MessageSection[] {
  if (message.timelineBlocks?.length) {
    return message.timelineBlocks.map((block) => {
      if (block.type === 'content') {
        return { id: block.id, type: 'content', text: block.text };
      }
      if (block.type === 'thought') {
        return { id: block.id, type: 'thought', text: block.text };
      }
      if (block.type === 'attachments') {
        return { id: block.id, type: 'attachments', attachments: block.attachments };
      }
      return { id: block.id, type: 'tools', toolCalls: block.toolCalls };
    });
  }

  const sections: MessageSection[] = [];
  if (message.content.trim()) sections.push({ type: 'content', text: message.content });
  if (message.attachments?.length) sections.push({ type: 'attachments', attachments: message.attachments });
  if (message.thought) sections.push({ type: 'thought', text: message.thought });
  if (message.toolCalls?.length) sections.push({ type: 'tools', toolCalls: message.toolCalls });
  return sections;
}

export function getToolGroupSummary(toolCalls: ToolCall[]) {
  const counts = toolCalls.reduce(
    (current, tool) => {
      const kind = tool.kind ?? inferToolKind(tool.name);
      if (kind === 'search') current.search += 1;
      else if (kind === 'fetch') current.fetch += 1;
      else if (kind === 'execute') current.execute += 1;
      else if (kind === 'edit') current.edit += 1;
      else current.other += 1;
      if (tool.status === 'error') current.failed += 1;
      return current;
    },
    { search: 0, fetch: 0, execute: 0, edit: 0, other: 0, failed: 0 },
  );

  const parts: string[] = [];
  if (counts.search) parts.push(`已搜索 ${counts.search} 次`);
  if (counts.fetch) parts.push(`已抓取 ${counts.fetch} 次`);
  if (counts.execute) parts.push(`已运行 ${counts.execute} 条命令`);
  if (counts.edit) parts.push(`已编辑 ${counts.edit} 次`);
  if (counts.other) parts.push(`已调用 ${counts.other} 个工具`);
  if (counts.failed) parts.push(`${counts.failed} 个失败`);
  return parts.length ? parts.join(' · ') : `已调用 ${toolCalls.length} 个工具`;
}

function inferToolKind(name: string) {
  switch (name) {
    case 'web_search':
    case 'memory_search':
      return 'search';
    case 'web_fetch':
    case 'http_request':
      return 'fetch';
    case 'terminal':
    case 'code_execution':
    case 'patch':
      return 'execute';
    case 'todo':
      return 'edit';
    default:
      return 'other';
  }
}
