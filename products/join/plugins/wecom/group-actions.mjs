// "/建群 标题 @a @b" in a group assistant reply asks the Relay to create a WeCom group
// with the requester and the named colleagues, bound to the same OpenCraft server.
export function parseCreateChat(text) {
  if (typeof text !== 'string') return null;
  const m = /^\s*\/建群[ \t]+(.+)$/mu.exec(text);
  if (!m) return null;
  const members = [...new Set([...m[1].matchAll(/@([A-Za-z][A-Za-z0-9_.-]{1,63})/gu)].map(x => x[1]))].slice(0, 50);
  const title = m[1].replace(/@[A-Za-z][A-Za-z0-9_.-]{1,63}/gu, '').replace(/\s+/gu, ' ').trim().slice(0, 60);
  return title ? { title, members } : null;
}

const NAMES = /@([A-Za-z][A-Za-z0-9_.-]{1,63})/gu;
const EDIT_LINE = /^\s*\/(拉人|移出|踢人|改群名)[ \t]+(.+)$/gmu;
/** "/拉人 @a", "/移出 @b" (or /踢人) and "/改群名 新名" lines, merged into the final requested membership of the current group. */
export function parseEditChat(text) {
  if (typeof text !== 'string') return null;
  const add = new Set(), remove = new Set(); let name;
  for (const [, verb, rest] of text.matchAll(EDIT_LINE)) {
    if (verb === '改群名') { const n = rest.trim().slice(0, 60); if (n) name = n; continue; }
    for (const [, who] of rest.matchAll(NAMES)) {
      // Provider updates are sets, not an ordered command list. Last intent wins.
      if (verb === '拉人') { remove.delete(who); add.add(who); }
      else { add.delete(who); remove.add(who); }
    }
  }
  if (!add.size && !remove.size && !name) return null;
  return { add: [...add].slice(0, 50), remove: [...remove].slice(0, 50), ...(name ? { name } : {}) };
}
export const stripEditLines = text => text.replace(/^\s*\/(拉人|移出|踢人|改群名)[^\n]*\n?/gmu, '');
