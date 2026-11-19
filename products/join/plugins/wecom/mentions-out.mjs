// Assistant replies name people as "@rtx". A stream reply cannot ping, so the Relay
// follows it with one rich_text mention for names that are current group members.
const TOKEN = /(?:^|[^A-Za-z0-9_.@-])@([A-Za-z][A-Za-z0-9_.-]{1,63})(?![A-Za-z0-9_.@-])/gu;

/** Distinct "@name" tokens in reply text (no @all). */
export function mentionedNames(text) {
  if (typeof text !== 'string') return [];
  const names = new Set();
  for (const m of text.matchAll(TOKEN)) if (m[1].toLowerCase() !== 'all') names.add(m[1]);
  return [...names].slice(0, 20);
}

const ALL = /(?:^|[^A-Za-z0-9_.@-])@(?:all|所有人|全体成员)(?![A-Za-z0-9_.@-])/iu;
/** Whether text asks to notify everyone ("@all", "@所有人", "@全体成员"). */
export const mentionsEveryone = text => typeof text === 'string' && ALL.test(text);
