// Internal IOA/WeCom vocabulary. No generic channel or assistant protocol.
export function wecomMention(event) {
  if (event.mentioned !== true || typeof event.text !== 'string') return null;
  // WeCom uses a four-per-em space after a mention. Its expanded UI label may
  // also repeat the name in parentheses (including spaces inside that name).
  // Only consume that expanded form when both names agree; ordinary request
  // parentheses must not be swallowed as part of a guessed display name.
  const raw = event.text.trimStart();
  const expanded = /^@([^\n\r()（）]+?)\s*[（(]\1[）)](?=\s|$)/u;
  const prefix = expanded.exec(raw)?.[0] ?? /^@[^\n\r\u2005]+\u2005/u.exec(raw)?.[0]
    ?? /^@\S+(?:[ \t]+|$)/u.exec(raw)?.[0];
  const text = (prefix ? raw.slice(prefix.length) : raw).trim();
  const command = text.normalize('NFKC').match(/^(帮助|help|菜单|命令|服务器|记录|历史|保存|关联)(?:\s+([A-Za-z0-9._-]{1,128}))?$/iu);
  if (command) return { kind: 'command', action: command[1], argument: command[2] ?? null };
  return { kind: 'assistant', text };
}
