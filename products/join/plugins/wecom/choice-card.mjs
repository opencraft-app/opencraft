// Group questions with fixed choices stay readable text everywhere: the prompt, numbered
// choices and a fixed hint line. The Relay recognises that exact shape and also shows
// a button card; the requester of the replied-to mention is the only accepted clicker.
export const CHOICE_HINT = '（点下方按钮，或 @我 回复选项）';
const label = v => typeof v === 'string' && v.trim() !== '' && v.length <= 80 && !/[\r\n]/u.test(v);

export function choiceQuestionText(prompt, choices) {
  const valid = Array.isArray(choices) ? choices.filter(c => label(c?.label)).slice(0, 6) : [];
  if (!valid.length) return prompt;
  return `${prompt}\n\n${valid.map((c, i) => `${i + 1}. ${c.label.trim()}`).join('\n')}\n${CHOICE_HINT}`;
}

export function parseChoiceQuestion(text) {
  if (typeof text !== 'string' || !text.endsWith('\n' + CHOICE_HINT)) return null;
  const lines = text.slice(0, -CHOICE_HINT.length - 1).split('\n');
  const choices = [];
  while (lines.length && /^\d\. ./u.test(lines.at(-1))) choices.unshift(lines.pop());
  if (!choices.length || choices.length > 6 || !choices.every((l, i) => l.startsWith(`${i + 1}. `)) || lines.at(-1) !== '') return null;
  const prompt = lines.slice(0, -1).join('\n').trim();
  return prompt ? { prompt, choices: choices.map(l => l.slice(3)) } : null;
}
